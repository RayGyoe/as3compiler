# HTTP Loading (`flash.net`) Alignment Investigation and Integration Plan

> This document answers one question: **how far is this project's `flash.net` loading surface
> (`URLLoader` / `URLRequest` / …) from the AIR SDK's official API, and can HTTP GET/POST be done, and
> how should it land**.
>
> Core conclusions up front:
>
> 1. **The existing implementation is merely an API-shaped shell over "local file reading"** — `URLLoader`
>    treats the URL as a filesystem path and `fopen`s it, and the three fields `URLRequest.method` / `.data` /
>    `.contentType` **can be written but are never read**. GET/POST **do not exist at all**, and the four classes
>    `URLRequestMethod` / `URLRequestHeader` / `URLStream` / `URLRequestDefaults` **do not exist whatsoever**.
> 2. **The real workload is not "call an HTTP library", but HTTPS/TLS and the three-target fork**: native can
>    build its own TCP+TLS or go through a platform network API, web can only use the browser's `fetch`
>    (constrained by CORS, forbidden from changing restricted headers), and WASI preview1 **has no socket at
>    all** — the same AS3 must give **honest and consistent** semantics on all three ends (run if there is a
>    network, `IOError` if not). **And there is no single general-purpose library that can cover all three
>    ends** (the boundary is at the **transport layer**, not the TLS primitives — see §4.1.1, including the
>    TypePHP precedent).
> 3. **Priority ordering**: completing the API surface (constant classes + fields + event contracts, **no
>    network needed**) is the low-risk, high-value first step; the HTTP client itself is **an independent
>    heavy engineering project**, best handled as a standalone effort advanced in phases, blocking no existing
>    stage.
>
> **Implementation status (stage eighty-nine / forty-eight through fifty-two, 2026-09-27)**: **A~I of
> roadmap §5 have all landed**: A/B (eighty-nine / forty-eight), the G + C probe (eighty-nine / forty-nine),
> the build-manifest `targets` layering (eighty-nine / fifty), the four backends D/E/F/H plus the API surface
> (eighty-nine / fifty-one: native curl kernel with response headers / redirects / idle timeout / all verbs,
> the web `fetch` backend, streaming `URLStream` jobs, `navigateToURL`/`sendToURL`), and **AIR semantics
> fidelity correction + end-to-end acceptance I** (eighty-nine / fifty-two).
> **Current three-target state**: native+`ASC_HAVE_CURL` and **web+`ASC_HAVE_FETCH`** really go online; a
> target with no backend (default native / WASI preview1) dispatches a **distinguishable** honest `ioError`;
> `securityError` still is not dispatched (there is no source that would refuse). On the native side real
> GET/POST/404/HTTPS all run through (libcurl, **opt-in**, see §4.1.2; since **stage eighty-nine / fifty-three**
> the example manifest goes through the `vendor/curl` **static** library, so the artifact is self-contained —
> `otool -L` shows no `libcurl.4.dylib`).
> Therefore statements in this text such as "fields can be written but not read", "`close()` is an empty
> function", and "the four classes do not exist" should be read as the **pre-work inventory**; each item's
> current state is governed by the **§3.1 table** (including file locations), C's integration shape/cost is in
> **§4.1.2**, and all acceptance and reverse comparisons (including the `mxmlc + adl` baseline) are in **§6**.
> The boundary beyond D (chunked progress, `responseHeaders`, proxy/cookie, `URLStream`, web `fetch`,
> `navigateToURL`) **landed in eighty-nine / fifty-one/fifty-two**; **proxy / cookie jar / HTTP-2, the static
> self-contained `vendor/` static curl, and the other protocols on top of socket/TLS
> (`Socket`/`ServerSocket`/`XMLSocket`) also landed in eighty-nine / fifty-three** (see §4.1, §7);
> what remains undone is heavy engineering requiring a third-party stack (preview2's `wasi:http`, AMF
> `readObject`, `SecureSocket`'s TLS state machine, `DatagramSocket`'s UDP).
>
> Every API detail in this document is **taken item by item from the AIR SDK official language reference**
> (`airsdk.dev/reference/actionscript/3.0/`), and the project's current state is **verified item by item via
> grep**, not a paraphrase of documentation or speculation.

---

## 1. What this requirement is and why it was raised

`flash.net` is AS3's **network loading package**: downloading text / binary / URL-encoded variables from a URL
(`URLLoader`), sending HTTP requests (`URLRequest`), low-level streaming download (`URLStream`), plus the
heavier parts like socket/peer-to-peer/file upload.

This project's current scope for `flash.net` is a **"minimal model with no network backend"** (README-CN.md
states plainly "real async HTTP/Socket loading is not implemented"): `URLLoader.load(request)` reads
`request.url` as a **local filesystem path**. That suffices in scenarios where "resources ship with the app and
are loaded via `file://` / relative paths" (Starling's `AssetManager` main path is exactly local resources), but
the moment an app actually requests `http(s)://…`, the behavior diverges completely from AIR.

The requirement comes from a direct question: **"Is `URLLoader` fully implemented? Can it POST and GET now?"**
This document is the complete answer to that — first the official standard, then the current-state gap, then
the landing plan.

---

## 2. The Full Official API Surface (authoritative source: [AS3 language reference `flash.net`](https://airsdk.dev/reference/actionscript/3.0/flash/net/package-detail.html))

### 2.1 `URLLoader` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoader.html))

Inherits `EventDispatcher → Object`. **Not visible to code until all data has finished downloading**; reports
progress via `bytesLoaded`/`bytesTotal` and events.

| Member | Signature | Semantic points (excerpts from the official text) |
|---|---|---|
| `bytesLoaded` | `uint = 0` | "the number of bytes loaded" |
| `bytesTotal` | `uint = 0` | "**always 0 while loading is in progress**; it has a value only when the operation completes; **indeterminate if the `Content-Length` header is missing**" |
| `data` | `*` | "populated **only after loading completes**"; the format is decided by `dataFormat` |
| `dataFormat` | `String = "text"` | `TEXT`/`BINARY`/`VARIABLES`, default `TEXT` |
| `URLLoader(request:URLRequest = null)` | constructor | **if a request is passed, loading starts immediately** (equivalent to constructing then calling `load`) |
| `load(request:URLRequest):void` | method | "sends and loads data from the specified URL"; **to send data, set `URLRequest.data`** |
| `close():void` | method | "**immediately terminates** an in-progress load; if there is no URL currently streaming, throws an invalid stream error" |

**`load()` throws**: `ArgumentError` (`requestHeaders` contains a restricted header), `Error` (GET UTF8→MBCS
failure / POST data memory allocation failure), `SecurityError` (local untrusted file going online / connecting
to a restricted port), `TypeError` (`request` or `URLRequest.url` is `null`).

**Events** (this is the heart of the contract):

| Event | Constant | When fired |
|---|---|---|
| `complete` | `Event.COMPLETE` | "**after all data has been decoded and placed in `data`**; data is accessible only after this event" |
| `open` | `Event.OPEN` | "fired when the download **begins** after a `load()` call" |
| `progress` | `ProgressEvent.PROGRESS` | "when data is received during the download"; **URLLoader cannot obtain data before completion, so progress is only a progress notification** |
| `ioError` | `IOErrorEvent.IO_ERROR` | "a fatal error that **terminates the download**" (this project's error numbers are in §6.7.5) |
| `httpStatus` | `HTTPStatusEvent.HTTP_STATUS` | when HTTP-accessed and the environment can obtain a status code; **dispatched before complete/error (and additionally)** |
| `httpResponseStatus` | `HTTPStatusEvent.HTTP_RESPONSE_STATUS` | **AIR**: dispatched **before any response data**, carrying `responseHeaders`/`responseURL` |
| `securityError` | `SecurityErrorEvent.SECURITY_ERROR` | cross-sandbox / invalid SWZ certificate |
| `certificateError` | `SecurityErrorEvent.CERTIFICATE_ERROR` | **AIR 51**: invalid server certificate (self-signed/untrusted/expired); `cancelable=true`, `preventDefault()` lets it through |

> Event-order iron rule (official `HTTPStatusEvent` page): **HTTPStatusEvent is always dispatched before the
> error/completion event**.

### 2.2 `URLLoaderDataFormat` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoaderDataFormat.html))

`final` constant class: `TEXT = "text"`, `BINARY = "binary"`, `VARIABLES = "variables"`.
- `TEXT` → `data` is a `String` (file text)
- `BINARY` → `data` is a `ByteArray` (raw binary)
- `VARIABLES` → `data` is a `URLVariables` (URL-encoded variables)

### 2.3 `URLRequest` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequest.html))

`final`. **"Packs all the information of one HTTP request into a single object"** — passed to `Loader.load()` /
`URLStream` / `URLLoader.load()`.

| Property | Type | Default | Note |
|---|---|---|---|
| `url` | `String` | — | the requested URL |
| `method` | `String` | `URLRequestMethod.GET` | "controls the HTTP form submission method"; **Flash Player (browser) is restricted to GET/POST**; **any string is allowed inside the AIR application sandbox**; **throws `ArgumentError` for non-GET/POST** (outside the application sandbox) |
| `data` | `Object` | — | data sent with the request; **on GET it is appended to `url` as a query string; on POST (or any non-GET) it goes into the request body**; can be `ByteArray`/`URLVariables`/`String` (otherwise converted to a string) |
| `contentType` | `String` | **`null`** | the MIME type of `data`; **must correspond to `data`'s actual type**. ⚠️ The default value `application/x-www-form-urlencoded` printed in the official docs is **the wire default when adl sends the packet**, **not the property value** — in adl measurement the property is always `null` (pitfalls and the capture matrix are in §6.7.7) |
| `requestHeaders` | `Array` | — | an array of `URLRequestHeader`; **browser restriction: custom headers only take effect for POST, not supported for GET** |
| `authenticate` | `Boolean` | `true` | **AIR**: whether to handle authentication challenges |
| `cacheResponse` | `Boolean` | `true` | **AIR**: whether to cache successful responses |
| `followRedirects` | `Boolean` | `true` | **AIR**: whether to follow redirects |
| `idleTimeout` | `Number` | 0 (use the OS default) | **AIR 2**: idle timeout (ms) waiting for a response after the connection is established |
| `manageCookies` | `Boolean` | `true` | **AIR**: whether the HTTP stack manages cookies |
| `useCache` | `Boolean` | `true` | **AIR**: whether to check the local cache first |

Method: `useRedirectedURL(sourceRequest, wholeURL=false, pattern=null, replace=null)` (**AIR 3.8**, replaces a
new request's domain/whole URL with a redirected request's URL).

> `URLRequest` is `final`, constructor `URLRequest(url:String = null)`.

### 2.4 `URLRequestMethod` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestMethod.html))

`final` constant class (**6**, one more than the GET/POST most people assume): `GET`, `POST`, `PUT`, `DELETE`,
`HEAD`, `OPTIONS` (all the corresponding same-named strings).

### 2.5 `URLRequestHeader` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestHeader.html))

`final`. Encapsulates **a single** HTTP request header (a name/value pair).

| Member | Signature |
|---|---|
| `name` | `String` |
| `value` | `String` |
| constructor | `URLRequestHeader(name:String = "", value:String = "")` |

**Restricted headers** (using them outside the application sandbox throws a runtime error, **case-insensitive**):
`Accept-Charset`, `Accept-Encoding`, `Authorization`, `Connection`, `Content-Length`, `Cookie`, `Host`,
`Referer`, `User-Agent`, `x-flash-version`, and a long list (the full list is on the official page). Inside the
AIR application sandbox any request header is allowed. AIR by default sets the `ACCEPT` header to a list of MIME
types (unless you explicitly set `ACCEPT` in `requestHeaders`).

### 2.6 `URLRequestDefaults` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestDefaults.html))

**AIR 1.0**. Static properties that define **default values** for `URLRequest`'s properties (any value set on a
`URLRequest` instance overrides them).

| Static member | Default |
|---|---|
| `authenticate` / `cacheResponse` / `followRedirects` / `manageCookies` / `useCache` | all `true` |
| `idleTimeout` | 0 |
| `userAgent` | a UA string that varies with OS/language/version |
| `setLoginCredentialsForHost(hostname, user, password)` | static method, sets a host's default auth credentials (**effective across the whole application domain**) |

> Only usable from AIR application-sandbox content; otherwise accessing the members throws `SecurityError`.

### 2.7 `URLVariables` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLVariables.html))

**`dynamic class`** (undeclared properties can be added dynamically). Used to pass variables between the app and
the server, paired with `URLRequest.data`.

| Member | Signature | Note |
|---|---|---|
| constructor | `URLVariables(source:String = null)` | **if a string is passed, `decode()` is called automatically** |
| `decode` | `decode(source:String):void` | "converts a variable string into properties"; **a non-URL-encoded name/value string throws `Error`** |
| `toString` | `toString():String` | returns all enumerable variables encoded as **`application/x-www-form-urlencoded`** |

### 2.8 `URLStream` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLStream.html))

Inherits `EventDispatcher`, **implements `IDataInput`**. **Low-level** download: **data is readable as soon as
it arrives** (unlike `URLLoader`, which waits for the whole file), and it **can `close()` before the download
completes**. Content is provided as **raw binary**.

- **Read operations are non-blocking**: you must check `bytesAvailable` before reading; if data is insufficient
  it throws `EOFError`.
- Byte order defaults to **big-endian**. Security rules are the same as `URLLoader`.

| Member | Note |
|---|---|
| `bytesAvailable` (read-only) | number of readable bytes in the input buffer |
| `connected` (read-only) | whether connected |
| `endian` | byte order (`Endian.BIG_ENDIAN`/`LITTLE_ENDIAN`, default big-endian) |
| `objectEncoding` | AMF version |
| `load(request)` / `close()` | start / immediately close the download |
| `read*` | `readBoolean`/`readByte`/`readBytes`/`readDouble`/`readFloat`/`readInt`/`readMultiByte`/`readObject`/`readShort`/`readUnsignedByte`/`readUnsignedInt`/`readUnsignedShort`/`readUTF`/`readUTFBytes` |

Events are the same family as `URLLoader` (`complete`/`open`/`progress`/`ioError`/`httpStatus`/
`httpResponseStatus`/`securityError`/`certificateError`). **Key difference**: at `progress`, **the data is
already readable**; "if there is an `httpResponseStatus` listener, error responses are also dispatched as
content via `progress`/`complete`, rather than `ioError`".

### 2.9 Event classes

| Class | Key members |
|---|---|
| `HTTPStatusEvent` ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/events/HTTPStatusEvent.html)) | `status:int` (read-only; **always 0 when the environment cannot obtain a status code**), `responseURL:String`, `responseHeaders:Array`, `redirected:Boolean`; constants `HTTP_STATUS`/`HTTP_RESPONSE_STATUS`. **Always dispatched before the error/completion event** |
| `SecurityErrorEvent` | constants `SECURITY_ERROR`, `CERTIFICATE_ERROR` (AIR 51); `text:String` |
| `ProgressEvent` | `bytesLoaded:uint`, `bytesTotal:uint`; constant `PROGRESS` |
| `IOErrorEvent` | `text:String`, `errorID:int` (AIR); constant `IO_ERROR`. Events the runtime **generates itself** carry an AIR error number (`2032`/`2035`/`2036`/`2124`) and the verbatim text `Error #N: <sentence>. URL: <url>` (eighty-nine / fifty-nine, measured matrix in §6.7.5); `new IOErrorEvent(...)`'s `errorID` is still `0` (AIR's constructor does not accept an error number) |

### 2.10 Package-level functions and the remaining `flash.net` classes

**Package-level functions** ([official page](https://airsdk.dev/reference/actionscript/3.0/flash/net/package.html)):

| Function | Signature | Note |
|---|---|---|
| `navigateToURL` | `(request:URLRequest, window:String = null):void` | **in AIR opens the URL in the default system browser**; under AIR POST is treated as GET |
| `sendToURL` | `(request:URLRequest):void` | sends a request but **ignores the response** |
| `registerClassAlias` | `(aliasName:String, classObject:Class):void` | preserves class information during AMF serialization |
| `getClassByAlias` | `(aliasName:String):Class` | looks up a class by alias; throws `ReferenceError` if unregistered |

**The complete `flash.net` class table** (official package-detail, used to delimit "this package's full scope"):
`DatagramSocket`, `FileFilter`, `FileReference`, `FileReferenceList`, `GroupSpecifier`,
`InterfaceAddress`, `IPVersion`, `LocalConnection`, `NetConnection`, `NetGroup`, `NetGroupInfo`,
`NetGroupReceiveMode`, `NetGroupReplicationStrategy`, `NetGroupSendMode`, `NetGroupSendResult`,
`NetMonitor`, `NetStream`, `NetStreamAppendBytesAction`, `NetStreamInfo`, `NetStreamMulticastInfo`,
`NetStreamPlayOptions`, `NetStreamPlayTransitions`, `NetworkInfo`, `NetworkInterface`, `ObjectEncoding`,
`Responder`, `SecureSocket`, `ServerSocket`, `SharedObject`, `SharedObjectFlushStatus`, `Socket`,
`URLLoader`, `URLLoaderDataFormat`, `URLRequest`, `URLRequestDefaults`, `URLRequestHeader`,
`URLRequestMethod`, `URLStream`, `URLVariables`, `XMLSocket`.

---

## 3. Current-State Inventory (implemented / missing / divergent)

> Verification method: `grep` `src/symbols.ts` (class/field/method/constant registration) and `src/emit.ts`
> (code generation), item by item against §2.
>
> **This section has been updated to the post-implementation state of stage eighty-nine / fifty-one (D/E/F/H)**
> — eighty-nine / forty-eight landed **A (semantics-layer completion) + B (`URLLoader` contract completion)**
> of the §5 roadmap (zero network dependency); eighty-nine / forty-nine landed **G (honest `ioError` for
> no-network targets)** and **C's native vertical probe** (opt-in libcurl); eighty-nine / fifty-one landed
> C/D/E/F/H entirely: the curl kernel completed with response headers / redirect counting / idle timeout /
> `HEAD`, `URLLoader`'s complete event sequence, the web `fetch` backend, the streaming `URLStream` job and
> `navigateToURL`/`sendToURL`.
> The original inventory (before A/B) is preserved in the tables' "before" descriptions, to help verify whether
> the divergences were truly eliminated.
> **What remains undone** is only heavy engineering needing a third-party stack: **preview2's `wasi:http`**
> (native WASI networking) and **AMF** (`readObject`/`registerClassAlias`). **Other protocols on top of
> socket/TLS** and **static self-contained packaging** landed in **stage eighty-nine / fifty-three**
> (`Socket`/`ServerSocket`/`XMLSocket` see §7, static curl see §4.1).
> **On the image side**: `Loader.load`'s `http(s)://` path was connected to the same seam in
> **stage eighty-nine / fifty-four** (§6.7.2 measurement).

### 3.1 Implemented (state after A/B)

| Item | Location | Current state |
|---|---|---|
| `URLLoader.data` (`any`) | `symbols.ts:1236` | ✅ format follows `dataFormat` (text / binary / **variables**) |
| `URLLoader.dataFormat` | `symbols.ts:1237` | ✅ all three values take effect (before A/B, `VARIABLES` never produced a `URLVariables`) |
| `URLLoader.bytesLoaded` / `bytesTotal` | `symbols.ts:1238` | ✅ **new**: always `0` during loading, set to the byte count on completion (AIR contract) |
| `URLLoader(request)` constructor parameter | `symbols.ts:1249` / `emit.ts:4168` | ✅ **new**: passing it starts loading (AIR) |
| `URLLoader.load()` | `emit.ts:4266` | ✅ **http(s) three-target fork**: native+`ASC_HAVE_CURL` goes through libcurl, web+`ASC_HAVE_FETCH` goes through the browser's `fetch`, other targets dispatch a **distinguishable** honest `ioError`; non-http `file://`/relative paths still go through local `fopen` (the `file://` prefix is stripped). See §4.1.2 / §5 |
| `URLLoader` events | `emit.ts:4228` (job finish) | ✅ complete sequence (eighty-nine / fifty-two, corrected per `adl` measurement): `open` (only when the request really reaches the transport) → [ `httpResponseStatus` only when status `> 0`, carrying url/headers/`redirected` ] → **replayed `progress`** (the backend's recorded byte watermark) → final `progress` → `data` populated → `httpStatus` (**carries only `status`**, `0` for non-HTTP loads) → `complete`. **4xx/5xx are successful loads** (a 404 also `complete`s, with `data` = the error body) — **only when an `httpResponseStatus` listener is registered** (see §6.7.5 and the TODO leftover table); transport-failure path: [ `open` if already started ] → `httpStatus(0)` → `data` = **empty value** (not `null`) → an `ioError` with AIR error number `#2032` (`Error #2032: Stream Error. URL: <url>`, stage eighty-nine / fifty-nine; other failures share the same number, see §6.7.5). ⚠️ `securityError`/`certificateError` are still never dispatched (there is no source that would refuse), and the `REDIRECT` event is not modeled (the `redirected` flag is filled) |
| `URLLoader.close()` | `emit.ts:4397` | ✅ **really aborts** (before A/B it was an empty function): cancels the in-flight job, dispatches no further terminating event; throws AIR's invalid stream error when there is no stream |
| `Loader.load()` (image, `flash.display`) | `emit.ts:4013` | ✅ **http(s) and local go through the same transport seam** (eighty-nine / fifty-four, connected on the web side in eighty-nine / fifty-six): the URL prefix forks at submit time — `AS_JOB_IMAGE_URL` goes through the transport backend (native `ASC_HAVE_CURL` runs `as_http_perform` on a worker; web `ASC_HAVE_FETCH` starts a `fetch` and decodes the body in the frame-boundary pump), while local paths are still `AS_JOB_IMAGE` (read the file + decode); failures dispatch `ioError` with the **AIR error number** (eighty-nine / fifty-nine): local missing `#2035`, transport failure or HTTP≥400 `#2036`, payload not an image `#2124`, no backend `0` (AIR has no such state), with the text being AIR's verbatim `Error #N: <sentence>. URL: <url>`; on success the content enters the display as the Loader's **own child** (`numChildren == 1`). See §6.7.2 / §6.7.4 / §6.7.5 for measurements |
| `URLRequest.url` | `symbols.ts:1184` | ✅ |
| `URLRequest.method` | `symbols.ts:1185` | ✅ real state, and it **really takes effect** (both the native/web backends consume it: `HEAD` goes to `NOBODY`, `POST/PUT/...` send a body, `GET` folds the query) |
| `URLRequest.data` | `symbols.ts:1186` | ✅ real state; folded into the query on GET and used as the body for other methods (both `ByteArray` and `URLVariables` are supported; server echo is in §6.4) |
| `URLRequest.contentType` | `symbols.ts:1187` | ✅ **property default is `NULL`** (consistent with adl; it was changed to a MIME string per the docs during A/B, and reverted in eighty-nine / sixty-nine per measurement); **the packet-sending contract is separate**: for a request with a non-empty body and no declaration (or a declaration of `""`), adl's wire default `application/x-www-form-urlencoded` is sent, and for a request with no body none is sent — see §6.7.7 |
| `URLRequest`'s 8 AIR properties + `digest` | `symbols.ts:1189`–`1199` | ✅ **new** (`requestHeaders` is initially an empty `Array`, compatible with the `.push()` usage in Adobe docs); of these, `followRedirects`/`idleTimeout` **really take effect** (mapped to `CURLOPT_FOLLOWLOCATION` / the low-speed limit pair on the curl side, and to `redirect: 'follow'/'manual'` and `AbortSignal.timeout` on the web side), and `userAgent`/`contentType` go into the request headers |
| `URLRequest.useRedirectedURL()` | `symbols.ts:1203` / `emit.ts:4140` | ✅ **new**, per the official doc semantics: first do the domain/full replacement, then the `pattern`→`replace`; both String and RegExp `pattern`s are supported |
| `URLRequestDefaults` (7 static properties) | `symbols.ts:1326` / `emit.ts:4087` | ✅ **new**; behind the static getter/setter are hand-written C globals; a `URLRequest` reads its defaults from it at construction (official contract). `setLoginCredentialsForHost` is still deferred (needs an authenticating HTTP stack) |
| `URLRequestMethod` (6 constants) | `symbols.ts:1266` | ✅ **new** |
| `URLRequestHeader` (`name`/`value`) | `symbols.ts:1277` | ✅ **new** (constructor defaults `""`/`""`) |
| `URLVariables` (`dynamic`, `ctor(source)`, `toString()`, **`decode()`**) | `symbols.ts:1363` / `emit.ts:4336` | ✅ dynamic class + construction + `toString` + **`decode()` (new)** all landed |
| `URLLoaderDataFormat` (TEXT/BINARY/VARIABLES) | `symbols.ts:1342` | ✅ three constants |
| `HTTPStatusEvent` (`status`/`responseURL`/`responseHeaders`/`redirected`) | `symbols.ts:1954` / `emit.ts:3780` | ✅ **all four properties filled** (eighty-nine / fifty-one): `status` takes the response status code; `responseHeaders` is parsed from the header block before the backend's first chunk into a `URLRequestHeader` array (**on the web side header names are normalized to lowercase by the browser**, faithfully reflected); `responseURL` is the **effective URL** (the final address after redirects, copied into the GC rather than pointing at the job); `redirected` is given by the backend's redirect count. **The two events divide the work** (eighty-nine / fifty-two): `httpStatus` **carries only `status`** (`responseURL=null`, `responseHeaders` an empty array, `redirected=false`), and `httpResponseStatus` is the one that carries url/headers/`redirected`; 4xx/5xx are successful loads and dispatch `complete` |
| `URLStream` (`load`/`close`/13 `read*`/`bytesAvailable`/`connected`/`endian`/`objectEncoding`) | `symbols.ts:1385` / `emit.ts:4450` | ✅ **new** (eighty-nine / fifty-one): a streaming job; `bytesAvailable` grows as data arrives; `read*` is non-blocking and throws `EOFError #2030` when data is insufficient, and throws a plain `Error` when "never opened at all"; `close()` throws `#2029`; on completion the unconsumed remainder is **copied** into a GC `ByteArray` before clearing `_job` (the copy happens before the terminal event is dispatched, so a listener can read the tail). `readObject` is not implemented (AMF depends on ObjectEncoding, see §3.2) |
| `SecurityErrorEvent` (`SECURITY_ERROR`, `text`) | `symbols.ts:1978` | ⚠️ **still never dispatched** (this machine has AIR's application-sandbox semantics, so there is no source that would refuse); missing `CERTIFICATE_ERROR`. See also §4.4 |

### 3.2 Still unimplemented (beyond A/B)

| Class / function | Gap |
|---|---|
| `URLStream.readObject` | ❌ the only missing read method is AMF deserialization (depends on `objectEncoding` and `registerClassAlias`, same batch as the AMF family in §3.2) |
| `registerClassAlias`/`getClassByAlias` | ❌ (AMF serialization only, same batch as `readObject`/`writeObject`) |
| `DatagramSocket` (UDP) | ❌ not implemented (a different base from TCP, a standalone effort) |
| `Socket`/`SecureSocket`/`ServerSocket`/`XMLSocket` | ✅ **landed (stage eighty-nine / fifty-three)**: TCP base + complete `IDataInput`/`IDataOutput`; `SecureSocket` is API surface only + honest failure (`isSupported=false`, TLS state machine not done). Semantics in detail in §7 |
| `FileReference`/`FileReferenceList`/`FileFilter` | ❌ |
| `LocalConnection`/`NetConnection`/`NetStream`/`NetGroup*` | ❌ (`NetStream` has only a dynamic `client` slot, see `symbols.ts:2451`) |
| `NetworkInfo`/`NetworkInterface`/`InterfaceAddress`/`IPVersion`/`Responder` | ❌ |
| Static self-contained packaging (including the `vendor/` static library with curl) | ✅ **landed (stage eighty-nine / fifty-three)**: `vendor/curl` provides `libcurl.a`/`libnghttp2.a`/`libz.a`, and `otool -L` no longer shows `libcurl.4.dylib` (see §4.1) |
| Proxy / cookie jar / HTTP-2 | ✅ **landed (stage eighty-nine / fifty-three)**: process-level `CURLSH` sharing cookies (`URLRequest.manageCookies`), two routes (environment variables and the **system proxy**), `ASC_HTTP2` opt-in (still defaults to 1.1, see §4.1) |
| WASI preview2 `wasi:http` | ⚠️ not done (preview1 has no socket primitive; the honest `ioError` is the current terminal state, see §5-G) |

### 3.3 One-sentence summary of the divergence

> **This project's current `URLLoader` is a "local file reader" wearing an HTTP API shell**: the URL is treated
> as a path, and `close()` (before the change) is a no-op. Stage eighty-nine / forty-eight eliminated the
> **misleading** part of it: `method`/`data`/`contentType` are no longer dead fields,
> `URLRequestMethod`/`URLRequestHeader`/`URLRequestDefaults` are all three present, the `open` event is
> dispatched, `bytesLoaded`/`bytesTotal` exist, `close()` really aborts, and `dataFormat=VARIABLES` really
> produces a `URLVariables`.
>
> Stage eighty-nine / forty-nine then pushed it from a "shell" to **two honest endpoints**:
> (a) **attach a backend and it really goes online** (native + `ASC_HAVE_CURL`, GET/POST/status codes/HTTPS all
> pass, probe in §6.2); (b) **without a backend it honestly errors** (`http(s)://` dispatches a distinguishable
> `ioError`, no longer sharing text with "file not found"). The default build is still **zero-dependency,
> self-contained, no-network** — the backend is the opt-in `ASC_HAVE_CURL`.
>
> Stage eighty-nine / fifty-one pushed it to a terminal state where **all three targets have a clear answer**:
> native (libcurl) and web (`fetch`) **really go online with aligned semantics** (the same family of AS3 probes
> asserts item by item on both ends, §6.4/§6.5/§6.6), and a target with no backend **honestly errors** with text
> naming what is missing and where to look. `URLStream`'s streaming semantics (incremental visibility +
> non-blocking reads) are consistent on both ends; `navigateToURL` on native goes through `fork+exec`
> (**not via a shell**), on web through `window.open`, and on WASI explicitly reports `#2032`.
>
> Stage eighty-nine / fifty-three added **the other leg**: other protocols on top of socket/TLS (§7) and static
> self-contained packaging (§4.1) — `Socket`/`ServerSocket`/`XMLSocket` landed per AIR-measured semantics, and
> native builds no longer have a `libcurl.4.dylib` runtime dependency.
>
> Stage eighty-nine / fifty-four connected **images** to the same seam too: `Loader.load(http(s)://…)` is no
> longer treated as a local path `fopen` (which used to report "file not readable" — honest about the **wrong
> cause**), but really downloads + decodes onto the screen; it also fixed a **real bug** along the way — the
> content was attached only to `loader.content` and not added to the Loader's children, and the renderer walks
> a container's children, so **not a single pixel was drawn**.
>
> **Still incomplete and not pretending to be complete**: `securityError` is still never dispatched (there is
> no source that would refuse); `readObject`/the AMF family; preview2's `wasi:http`; `SecureSocket`'s **TLS
> state machine** (`isSupported` is always `false`, `connect()` dispatches `#2031`, and it never silently makes
> a plaintext connection); `DatagramSocket` (UDP); and `ServerSocket.accept()` — a synchronous accept path AIR
> lacks — is a **subset addition** (AIR only dispatches events; this implementation can go either way, and each
> connection is delivered only once).

---

## 4. Key Technical Difficulties

### 4.1 Difficulty one: HTTPS/TLS is the real threshold, not HTTP itself

A plaintext HTTP/1.1 client (TCP + request line/headers/body + response parsing) is standard work, not hard.
But **real-world URLs are almost all `https://`**, and AIR's `URLRequest` explicitly supports `http` **and**
`https`. This brings in TLS: certificate chain validation, SNI, ALPN, the system root certificate store.

Per AGENTS.md §2.9's principle "link mature libraries for heavy work, don't reinvent the wheel", the options:

| Approach | Note | Trade-off |
|---|---|---|
| **Platform network API** | macOS `NSURLSession` / Windows `Schannel` / the Linux platform stack | no TLS maintenance, but **a separate glue per platform**, and behavioral details (timeout/redirect) are controlled by the platform |
| **One library throughout: libcurl** | `link-libs: curl`, one codebase across macOS/Linux/Windows (the TLS backend auto-selects SecureTransport/Schannel/OpenSSL) | **one implementation for three native platforms**; the cost is the root-certificate source and size. **This is TypePHP's actual choice** (see §4.1.1) |
| **Self-built socket + linked TLS library** | `mbedTLS` / `OpenSSL` / `wolfSSL` (`link-libs`) | maximum control, sizably trimmable, but HTTP/1.1 request construction and response parsing must be **written out in full yourself** |
| **Plaintext HTTP only** | no `https` support | semantically incomplete, usable only as a stage-one validation |

> Conclusion: **the TLS selection is the first decision point at project inception**. If you want "one native
> implementation", the first choice is to **link libcurl directly** (HTTP/1.1 + TLS + redirects + proxy in one,
> the same path as TypePHP); plaintext HTTP is only for stage-one validation, not a terminal state.
> **How to bring it in (system library vs `build-tools/`→`vendor/` self-build) is in §4.1.2.**

#### 4.1.1 The preliminary question: is there "one general-purpose library that adapts to all terminals"? — **No**, the boundary is at the transport layer

Before selecting, one thing must be nailed down first: **"the TLS library is portable" does not mean "the
network is portable"**. `mbedTLS` / `wolfSSL` / `BearSSL` / `OpenSSL` are all portable C and can all compile to
wasm; but on web and WASI they **have no socket to attach to** — what is missing is the **transport layer**, not
the TLS primitives. So "one library covering native + web + WASI" **does not hold** in principle.

Portability matrix (✅ usable / ⚠️ compiles but nowhere to land / ❌ unusable):

| Candidate | native (macOS/Linux/Windows) | web (Emscripten) | WASI **preview1** (this project's current target) | WASI **preview2** (TypePHP's target) |
|---|---|---|---|---|
| **libcurl** | ✅ one codebase for three platforms (TLS backend auto-selected) | ❌ **Emscripten has no official curl port** (`tools/ports/` has only zlib/libpng/SDL etc.) | ❌ no socket primitive | ❌ TypePHP **disables curl entirely** under WASI |
| **mbedTLS / wolfSSL / BearSSL** | ✅ | ⚠️ compiles, but **browsers forbid raw TCP**, nothing to attach the transport to | ❌ same | ❌ same |
| **OpenSSL** | ✅ | ⚠️ same (and large) | ❌ | ⚠️ TypePHP is **crypto-only, no TLS stream transport** |
| **Browser `fetch` / XHR** | ❌ (non-browser environment) | ✅ **the only viable one**; TLS/CORS/redirects are managed by the browser | ❌ | ❌ |
| **Host `wasi:http`** (Component Model) | ❌ | ❌ | ❌ preview1 has no such interface | ✅ **the only viable one** (TypePHP's actual choice) |

**Evidence (not speculation)**:

- The Emscripten official Networking documentation text: *"direct access to TCP sockets is not possible from
  web browsers"*, *"For HTTP transfers, one can use the browser built-in XmlHttpRequest (XHR) API and the newer
  Fetch API"*; and the official port list (`emscripten-core/emscripten/tools/ports/`) **has no curl**.
- **TypePHP's actual posture** (it has solved the same problem, so the trade-off can be copied directly):
  - **native**: build manifest `link-libs: - curl` (real socket + TLS); extension mode `ext-deps: - curl`
    (the official README notes *"Zend extension dependency, not a native link library"*).
  - **Nano (VM-less minimal runtime)**: the official docs state plainly *"does not provide socket, DNS,
    network, remote stream"* — **simply no networking capability**.
  - **WASI**: *"OpenSSL is built crypto-only and does not include the TLS stream transport; HTTP/HTTPS is still
    provided by the WASI HTTP Component"*; and PHPX Facade is disabled entirely, *"to avoid exposing unavailable
    APIs like curl, socket, Swoole as interfaces that 'compile but fail to link'", "statically identifiable calls
    report a fatal error at compile time"*.

**Direct implication for this project**: `URLLoader`'s HTTP path **can only** be made as "**one abstract seam +
three backends**" — native goes through libcurl (or a self-built socket+TLS library), web goes through `fetch`,
and WASI preview1 **honestly reports `ioError`** (to use `wasi:http` you must first upgrade to preview2 +
Component Model, which is an independent large effort — see §5 stage G). This is exactly the conclusion of
§4.2's "three-target fork"; this subsection merely **nails the preliminary question "is there a general-purpose
library" with evidence — the answer is no**.

#### 4.1.2 How to obtain and bring it in: first distinguish `build-tools/` from `vendor/`, libcurl **does not necessarily have to be compiled yourself**

> **Question (user annotation)**: does libcurl need to be downloaded into `build-tools/` first, then compiled
> into `as3compiler/vendor/`?
>
> **Answer**: **not necessarily**. There are two routes — first use the system library (zero download, zero
> vendor); only if you want static self-containment do you go `build-tools/` → `vendor/`. Below, the roles of
> the two directories are nailed down first (this is the repo's established division of labor, **not a
> libcurl-specific rule**).

**The repo's established division of labor** (see [`compile.md`](compile.md) §Build manifest, [`skia.md`](skia.md) §6.1):

| Directory | Role | Existing contents |
|---|---|---|
| `build-tools/` | **build input area**: **source + toolchain** that need to be recompiled themselves, **not part of runtime linking** | `skia-src/` (complete Skia source, recompilable with gn+ninja), `emsdk/` (Emscripten toolchain) |
| `as3compiler/vendor/` | **consumption area**: **precompiled artifacts**, where the build manifest's `include-paths`/`link-paths`/`link-libs` point | `skia/{include,lib/macos-arm64,lib/wasm}`, `sdl2/arm64/{include,lib}` (static `.a`), each glue `.cc/.mm` + `.o` |

That is, the established paradigm is "**put source that needs recompiling in `build-tools/`, put the compiled
static library in `vendor/<lib>/<platform>-<arch>/{include,lib}`**" — the reason Skia goes this way is that the
official precompiled package does not include Metal and **must be recompiled**. libcurl need not be so.

**Route one (recommended for the first phase): use the system library — zero download, zero compilation, zero vendor**

macOS **ships libcurl**: the SDK contains `usr/lib/libcurl.tbd` (a dynamic stub) and `usr/include/curl/*.h`.
The build manifest only needs `link-libs: ["curl"]`, and **not even `include-paths`/`link-paths` are needed**
(the SDK path is already in the default search path).

Measured (`cc -O2 probe.c -lcurl`, **with no `-I/-L` at all**):

| Check | Result |
|---|---|
| Compile and link | ✅ success (zero download, zero external dependency) |
| Runtime dependency | `otool -L` → `/usr/lib/libcurl.4.dylib` (**dynamically** linked system library) |
| Version / TLS backend | `curl 8.7.1` · `SecureTransport (LibreSSL/3.3.6)` |
| `https` protocol support | ✅ yes |
| Real HTTPS request | `https://example.com/` HEAD → `HTTP 200`, `curl_easy_perform` returns `CURLE_OK` |

- **Cost**: **dynamic linking** (a runtime dependency on the system dylib, so the produced binary is **not
  self-contained**); the version drifts with the OS (8.7.1 on this machine); **macOS only** — Linux needs the
  system `libcurl-dev`, and **Windows has no system libcurl**.
- Applicable to: local development, native first-phase validation, stages C/D. **This route does not touch
  `build-tools/` or `vendor/` at all**.

> **Route one has been measured and connected (stage eighty-nine / forty-nine)**: `URLLoader`'s `http(s)://`
> path was connected to the system libcurl per this subsection and ran through real GET/POST/404/HTTPS
> (reproduction in §6.2). The trade-offs of the three routes are no longer estimates:
>
> | Observation | Measured result |
> |---|---|
> | Self-containment | ❌ **indeed broken**: `otool -L` → `/usr/lib/libcurl.4.dylib` (dynamically linked system library) |
> | Binary size | **+600 B** (111,320 vs 110,720) — the library does not go into the binary, so the code itself hardly changes |
> | Generated C | **the same**: the fork is entirely in the compile macro `ASC_HAVE_CURL` (with it undefined, the same C falls back to the honest `ioError`) |
> | Cross-target | ⚠️ **once failed** (stage eighty-nine / forty-nine probe): feeding the same build manifest to wasm gives `wasm-ld: unable to find library -lcurl` straight away — because `link-libs` at the time was not target-conditional. **Lifted in stage eighty-nine / fifty** |
>
> This constraint was once the most binding build-layer finding of this item. **Stage eighty-nine / fifty
> landed the build-manifest `targets` override block** ([`compile.md`](compile.md) §4.1): the top level is the
> common default, and a `targets.<target>` block **wholly replaces** fields per target, so one manifest can link
> curl for native and drop it for wasm (measurement in §6.3). This is build-layer work that no networking
> landing can avoid, besides "route two (put a static self-contained library in `vendor/`)", and it is now in
> place.

> **Route two has landed (stage eighty-nine / fifty-three)**: `build-tools/curl-src/build-static.sh`
> (curl 8.11.1 + nghttp2 1.64.0 + zlib 1.3.1; nghttp2 needs `-DENABLE_TESTS=OFF -DBUILD_TESTING=OFF`) produces
> static libraries into `vendor/curl/{include,lib/macos-arm64}`; the build manifest's native layer is repointed
> to `vendor/curl`, and the new `--framework` CLI flag completes the macOS system frameworks. Measured:
> `otool -L` no longer shows `libcurl.4.dylib`/`libz.dylib`, and `examples/url-test`'s output is
> **byte-for-byte identical** to the dynamically linked version.
>
> **Proxy / cookie jar / HTTP-2 landed in the same stage**: the cookie jar goes through a process-level `CURLSH`
> (`CURL_LOCK_DATA_COOKIE` + `pthread_once`, with `CURLSHOPT_LOCKFUNC`/`UNLOCKFUNC`) + `CURLOPT_SHARE` per
> transfer, toggled by `URLRequest.manageCookies` (AIR default `true`); proxy has two routes —
> **environment variables** (`http_proxy` etc., handled natively by libcurl) and the **system proxy** (read from
> `SCDynamicStoreCopyProxies`, gated by `ASC_SYSTEM_PROXY`). The system proxy must sit in a **separate
> compilation unit**: `<SystemConfiguration/SystemConfiguration.h>` drags in `MacTypes.h`'s `struct Point`,
> which **hard-conflicts** with `flash.geom.Point`'s struct in the generated C (a new build-layer finding;
> `vendor/sysproxy_glue.c` + a new `--source` flag, with the generated C keeping only an `extern` declaration).
> End-to-end measured: `http://example.invalid/` gives `httpStatus(502); complete;` (a proxy reply) with
> `ASC_SYSTEM_PROXY` on, and `httpStatus(0); ioError;` with it off. **HTTP/2 is the opt-in `ASC_HTTP2`, still
> pinned to `HTTP/1.1` by default** — h2 normalizes response header names and omits connection-level headers,
> which is a fidelity difference as soon as it is visible to AS3 (AIR's transport is HTTP/1.1 to begin with).

**Route two (self-contained + one cross-platform implementation): only then go `build-tools/` → `vendor/`**

When you need a **static single-file executable**, or **one implementation across macOS/Linux/Windows**, only
then follow the same paradigm as Skia/SDL2: put the source in `build-tools/` (e.g. `build-tools/curl-src/`) +
a cross toolchain, put the static library artifacts in `vendor/curl/<platform>-<arch>/{include,lib}`, and point
the build manifest's `include-paths`/`link-paths`/`link-libs` there.

- **Why self-compilation is mandatory**: the SDK has **only the `.tbd` dynamic stub, no `libcurl.a`**
  (`find Xcode -name "libcurl*.a"` is empty) — to get static, you can only compile from source.
- **The real workload is not in curl, but in its transitive dependencies**: the TLS backend
  (mbedTLS/wolfSSL/OpenSSL/SecureTransport) + `zlib` + `brotli` + `zstd` + `nghttp2` + `libidn2`/PSL, and each
  must be **cross-compiled per platform**. The suggested minimal set: `curl + mbedTLS (or wolfSSL) + zlib`, and
  explicitly `--without-brotli --without-zstd --without-nghttp2 --without-libpsl --disable-ldap --disable-ssh2`.

> **Relationship to this project's stages**: this decision **belongs to stage C** (see §5). **Stages A/B have
> nothing to do with networking and require downloading or compiling nothing right now** — the full shape of
> "the TLS selection is the first decision point at project inception" mentioned in §4.1 is exactly this
> subsection's two routes.

### 4.2 Difficulty two: the three-target fork (the same AS3, three capabilities)

| Target | Capability | How to land it |
|---|---|---|
| **native** (macOS/Linux) | full TCP + TLS | self-built socket + TLS library (or a platform API) |
| **web** (Emscripten/wasm) | **cannot open a raw socket**; only `fetch()` (XHR) | go through the browser's `fetch` — TLS/CORS/redirects are handled by the browser; **restricted headers cannot be set**, and **cross-origin needs a server CORS header** |
| **WASI** (preview1) | **no socket primitive** | **honestly report `IOError`** (do not pretend success, AGENTS.md §2.5) |

This means `URLLoader`'s HTTP path must **dispatch by target** like the existing window/font backends, and
**both "failure on web due to CORS" and "failure on native due to the network" must land as the same `ioError`
semantics**, rather than each inventing its own.

### 4.3 Difficulty three: the relationship with the existing "async job + frame boundary" system (positive)

This project already has a mature **async job system** (stage eighty-nine / forty-five): a job table + a native
pthread pool + the frame boundary `as_async_tick()` publishing results (see [`as3-semantics.md`](as3-semantics.md)
§3, `examples/async-io.as`). HTTP loading is **naturally suited** to this system, but with one **upgrade point**:

- The existing job is **one-shot** (read → one result → one `complete`).
- HTTP needs **incrementality**: `open` → multiple `progress` (`bytesLoaded` increments) → `complete`; and
  `ProgressEvent.bytesTotal` depends on `Content-Length` ("indeterminate" if missing, see §2.1).
- `URLStream` goes further: **reads are non-blocking and data is available at any time** (`bytesAvailable`) —
  this requires the job buffer to **grow visibly to the AS3 side**, rather than "accumulate it all then hand it
  back at once". This needs rethinking alongside the invariant "the worker never touches the GC heap" (the
  buffer stays in malloc, and the main thread moves it segment by segment per `bytesAvailable`).

> Conclusion: the existing job system can reuse its skeleton (submit/claim/finish thunk/GC root), but a
> **"streaming job" form** (multiple intermediate publish points) must be added, rather than using only one-shot
> jobs. This is the **only substantive impact** of this investigation on the existing architecture.

### 4.4 Difficulty four: the security model (AIR really does have a sandbox)

Much of AIR's `URLRequest`/`URLLoader` documentation discusses the **security sandbox**: cross-origin needs a
URL policy file, the restricted request-header list, reserved ports, local untrusted files must not go online,
`certificateError` can be let through with `preventDefault()`. As a **desktop AOT runtime (running in the
application sandbox, equivalent to AIR's application sandbox)**, this project's reasonable simplifications are:

- **any method / any request header inside the application sandbox** (aligning with AIR application-sandbox
  behavior);
- **do not** do cross-origin policy files or reserved-port restrictions (those are browser/Flash Player
  constraints);
- `certificateError` may be **not implemented yet** (no UI to carry certificate interaction), with failure
  landing as `ioError` and an honest error report.

> This keeps the semantics autonomous while introducing no un-acceptable sandbox interaction.

---

## 5. Suggested Phased Roadmap (matching the existing "stage XX" convention)

| Stage | Goal | Needs network? | Risk | Status |
|---|---|---|---|---|
| **A semantics-layer completion** | `URLRequestMethod` (6 constants), `URLRequestHeader`, `URLRequestDefaults`, `URLVariables.decode()`, `URLRequest`'s 8 AIR properties, `useRedirectedURL()` | No | Low | ✅ **done (stage eighty-nine / forty-eight)** |
| **B URLLoader contract completion** | `bytesLoaded`/`bytesTotal`, the `URLLoader(request)` constructor parameter, the `open` event, `close()` really aborting, `dataFormat=VARIABLES` producing a `URLVariables` | No (goes through existing local jobs) | Low | ✅ **done (stage eighty-nine / forty-eight)**; the "additionally dispatch `securityError`" part **not done** — see the note below |
| **C HTTP client kernel (native)** | **link libcurl** (HTTP/1.1 + TLS + redirects + proxy in one, see §4.1.1) or a self-built socket + TLS library; includes response parsing (status line, headers, `Content-Length`/chunked/connection-close). **How to bring it in is in §4.1.2**: the first phase can use the macOS system libcurl with zero vendor; for static self-containment then go `build-tools/`→`vendor/` | **Yes** | **High (TLS)** | ✅ **done (eighty-nine / fifty-one)**: all verbs (`GET`/`POST`/`PUT`/`HEAD`→`NOBODY`/…), the response header block, `Content-Length`→`bytesTotal`, the effective URL + redirect count, `followRedirects`, `idleTimeout`→the low-speed limit pair, per-request headers (including UA/`Content-Type`); TLS is managed by libcurl (a real `https` probe in §6.2). **Proxy, cookie jar, HTTP/2 (opt-in) and static self-containment landed in eighty-nine / fifty-three** (see §4.1) |
| **C prerequisite: target-layered linking (build layer)** | Build-manifest `targets` override block: the top level is the common default, and `targets.<target>` wholly replaces fields per target, letting **one manifest** serve multiple targets with mutually exclusive link sets | No | Low | ✅ **done (stage eighty-nine / fifty)**, see [`compile.md`](compile.md) §4.1 |
| **D native hookup to `URLLoader`** | `http(s)://` goes over the network, `file://`/relative paths still go to files; GET (`data` folded into the query)/POST (`data` into the body); `httpResponseStatus`/`httpStatus` dispatched; `method` really takes effect | Yes | Medium | ✅ **done (eighty-nine / fifty-one, semantics corrected per `adl` measurement in eighty-nine / fifty-two)**: the complete event sequence `open`→[`httpResponseStatus` only when there are response headers]→**replayed `progress`**→final `progress`→`data`→`httpStatus`→`complete`. **Two key corrections**: ① **4xx/5xx are successful loads** — a 404 → `complete`, with `data` the error-page body (`ioError` is reserved for **transport failure**: refused connection/DNS/TLS/CORS); ② `httpStatus` **carries only `status`** (`responseURL=null`, `responseHeaders` an empty array, `redirected=false`), while `responseURL`/headers/`redirected` are all on `httpResponseStatus`; ③ every load ends with an `httpStatus` (non-HTTP loads give `status 0`). `HTTPStatusEvent`'s four properties are all filled; both `URLVariables`/`ByteArray` bodies run through (§6.4, §6.7) |
| **E web backend** | switch to `fetch`; CORS/restricted-header differences handled inside the glue; failures uniformly `ioError` | Yes | Medium | ✅ **done (eighty-nine / fifty-one, semantics corrected in eighty-nine / fifty-two)**: a `fetch` pull model + frame-boundary pump; **the same family of assertions passes 15/15 as on native** (§6.5), including the CORS-refusal text and a cross-origin 404; `ASC_HAVE_FETCH` opt-in |
| **F `URLStream`** | streaming jobs (incremental `bytesAvailable` + non-blocking `read*` + `EOFError`) | Yes | Medium-high | ✅ **done (eighty-nine / fifty-one)**: streaming job kind + incremental drain (measured 6 batches on native, 6 batches on web), 13 `read*` (missing `readObject`), `close()` really aborting and throwing `#2029`, tail copied on completion |
| **G WASI / no-network targets** | explicitly recognize remote schemes; with no backend dispatch a **distinguishable** `ioError` (no longer sharing text with "file not found") | — | Low | ✅ **done (stage eighty-nine / forty-nine)**; the web-side reverse comparison is in §6.5 |
| **H `navigateToURL`/`sendToURL`** | open the system browser (native `open`/`xdg-open`; web `window.open`); `sendToURL` ignores the response | Yes | Low | ✅ **done (eighty-nine / fifty-one)**: native `fork`+`exec` (**single argv, not via a shell** — the URL is app input, and going into a shell is a command-injection hole), web `window.open`, WASI honestly reporting `#2032`; an empty request throws `Error` (§6.6) |
| **I end-to-end acceptance** | local HTTP server GET/POST round-trip + `mxmlc + adl` comparison + reverse comparison | Yes | Medium | ✅ **done (eighty-nine / fifty-two)**: the real `examples/url-test` is run once under `mxmlc + adl` and once under this project's `--air-app --run`, with **the login POST + the stats GET matching item by item** (§6.7.1); the reverse comparison (default build, no backend) lands both requests on the honest `ioError`. Acceptance for C/D/E/F/H is in §6.2–§6.6 |

> **Paragraph-numbering convention**: this table follows the global small-step numbering "stage eighty-nine ·N"
> (consistent with `TODO.md`).
> Eighty-nine / forty-eight = A/B; forty-nine = G + the C probe; fifty = build-manifest `targets` layering;
> **fifty-one = C kernel completion + D/E/F/H**; **fifty-two = AIR semantics fidelity correction + end-to-end
> acceptance (I)** (acceptance in §6.2–§6.7).
> **Follow-ups outside the table (extensions of the same seam)**: **fifty-three = static self-containment +
> proxy/cookie/HTTP-2 + the socket layer** (§4.1/§7), **fifty-four = `Loader.load`'s `http(s)` images** (the
> image backend reuses `as_http_perform`, acceptance in §6.7.2).

> **A / B have nothing to do with networking**; they are "completing the API surface" — done first per this
> priority (stage eighty-nine / forty-eight), eliminating **misleading** divergences such as "set `POST` but
> nothing happens", "`close()` is an empty function", "`CONTENT_TYPE` defaults to null", and introducing no new
> backend.
> **G and the C native probe landed next (stage eighty-nine / forty-nine)**: G makes "no backend" failures
> **diagnosable** (a remote URL no longer shares one error sentence with a missing file), and the C probe uses
> real code to answer "what shape is hooking up libcurl, and how big is the cost" (§4.1.2 / §6.2) — **neither
> changes the default build**: the backend is the opt-in `ASC_HAVE_CURL`, and without declaring it the build is
> still zero-dependency, self-contained, and no-network.
> In the full networking engineering beyond D, this round (eighty-nine / fifty-one) took away the web `fetch`,
> the streaming `URLStream` job, `navigateToURL` and the C kernel completion; **what remains** is "heavy
> engineering requiring a third-party stack": static self-containment (the `vendor/` static curl),
> proxy/cookie jar/HTTP-2, other protocols on top of socket/TLS, preview2's `wasi:http`, AMF (`readObject`).
> **Stage eighty-nine / fifty completed D→I's build-layer prerequisite**: once the build-manifest `targets`
> override block landed, "one manifest across native/wasm" no longer needs a separate manifest per target
> ([`compile.md`](compile.md) §4.1).
>
> **About "additionally dispatch `securityError`" in B**: it is **deliberately not done** during A/B. Driving
> `SecurityErrorEvent` requires "a source that would refuse", and under this runtime's semantics (this machine =
> AIR application security sandbox, §4.4) there is no such source; force-dispatching it would instead create a
> false signal AIR would never have. It should land together with C/D's cross-origin/certificate failure paths.
> Likewise `HTTPStatusEvent` already has all four properties filled in **stage eighty-nine / fifty-one**
> (`status`/`responseHeaders`/`responseURL`/`redirected`), with real-value assertions on both the native and web
> ends (§6.4/§6.5); AIR's `REDIRECT` event is still not modeled (the `redirected` flag is filled).

---

## 6. Acceptance and Reverse Comparison

Per the project's established convention (AGENTS.md §2.7, `examples/*.as` + reverse comparison):

### 6.1 Stage A/B acceptance (headless-capable) — **executed**

- `examples/http-request-api.as`: the 6 `URLRequestMethod` constants, `URLRequestHeader` name/value, the 7
  `URLRequestDefaults` static defaults + a newly constructed `URLRequest` reading a changed default, `URLRequest`'s
  8 AIR properties and `digest`, `requestHeaders` being a `push`-able empty `Array`, `URLVariables.decode()`
  (values decoded / keys not decoded / re-entrant), and the four forms of `useRedirectedURL()` (default domain
  replacement, `wholeURL`, String `pattern`, RegExp `pattern`, asserting that the pattern only takes effect
  **after** the replacement).
  There is also a GC assertion: after assigning `URLRequestDefaults.userAgent` a concatenated string and calling
  `System.gc()`, it can still be read back — verifying it is registered as a permanent GC root (visible in the
  generated C as `as_urld_user_agent` inside `gc_mark_user_roots`).
- `examples/urlloader-contract.as`: passing a `URLLoader(request)` starts loading and **dispatches no event
  synchronously**; `open` is **before** `progress`/`complete`; during loading `bytesLoaded`/`bytesTotal` read `0`,
  and on completion are set to the byte count; after `close()` no terminal event is dispatched and `data` stays
  `null`; `close()` with no in-flight stream throws an invalid stream error; after `close()` the same loader can
  still `load()` again; with `dataFormat=VARIABLES` the `data` is a `URLVariables` whose values are already
  percent-decoded.
- **Measured** (both examples run through with `--run`):

  | Check | Evidence |
  |---|---|
  | Full regression | `node test.ts` → **119 passed / 0 failed / 119 total** (117 before A/B; two examples added) |
  | Affected old examples | `examples/stage63.as` (the `contentType` default assertion changed from `null` to a MIME string) and `examples/async-io.as` pass. ⚠️ **This line originally claimed `examples/air-native/` (including `NetUiDemos.as`) also PASSes; that conclusion does not hold**: that demo's `NetUiDemos.as:44` asserted `null` and was never synchronized, so `--run` threw an uncaught exception at stage 63, **exiting within 53 ms with the window never drawn**. The defect was not exposed and fixed by the runtime until stage eighty-nine / sixty-nine (this file's §6.7.7) |
  | native | both new examples pass `--run` |
  | wasm32-wasip1 | both new examples compile with `--target wasm`; `wasmtime --dir=.` runs them through (bare `wasmtime` does not preopen the CWD and will `ioError` on unreadable files — an environment, not code, issue, as with `examples/async-io.as`) |
  | Generated C readability | `URLLoader_ctor/_finish/_load/_close`, `URLRequest_useRedirectedURL`, `URLVariables_decode` are all hand-written-style readable C (AGENTS.md §2.6) |

> **No reverse comparison was done** (AGENTS.md §2.4's practice): this stage has no network behavior to restore,
> and "reverse" would mean changing the fields back to dead fields and `close()` back to an empty function —
> pure regression, of no diagnostic value. The reverse comparison for stages C/D is still required (§6.2).

### 6.2 Stage C probe + D(native) acceptance — **executed (stage eighty-nine / forty-nine; semantics corrected in eighty-nine / fifty-two)**

> ⚠️ **Eighty-nine / fifty-two correction**: this section originally recorded a 404 as
> `httpStatus(404);ioError;` ("no complete dispatched"), and claimed `httpStatus` comes **before** `progress` —
> both are the opposite of `adl`'s measurement. It has now been corrected per measurement:
> **a 404 is a normal response; the load `complete`s and `data` is the error-page body**; `ioError` is reserved
> for transport failure; the actual sequence is `open;progress;httpStatus(200);complete;` (`httpStatus` is
> **after** `progress` and before `complete`).
> The authoritative contract is in §6.4, and the AIR measurement is in §6.7.
>
> ⚠️ **Qualified in eighty-nine / fifty-nine, landed in eighty-nine / sixty-two**: the above "404 → `complete`"
> is **not unconditional** — it holds only when the caller has registered an `HTTP_RESPONSE_STATUS` listener
> (the probe that corrected it happened to register one). **Without** that listener, AIR dispatches
> `ioError #2032` after `httpStatus(404)`. Both halves are now implemented accordingly (the criterion is
> `EventDispatcher_hasEventListener`, with the threshold `status >= 300`); the controlled measurement (same
> server, same URL, the only variable being that listener) is in §6.7.6.

The probe scripts are in `temp/` (**not in `examples/`**: they need a live server and an opt-in backend, and are
unsuited to the no-network / default-build regression suite):

| File | Purpose |
|---|---|
| `temp/netprobe.as` | local server round-trip: GET body/status code, GET folded query, POST echo, 404, binary, connection refused |
| `temp/netprobe_https.as` | a real `https://example.com/` transfer + its 404 |
| `temp/netprobe_server.py` | a tiny local server (`/hello` `/query` `/echo` `/missing`) |
| `temp/netprobe.build.json` | `link-libs: ["curl"]` + `defines: ["ASC_HAVE_CURL"]` |

Reproduce (native):

```sh
python3 temp/netprobe_server.py 8731 &
node src/index.ts temp/netprobe.as        --manifest temp/netprobe.build.json --run
node src/index.ts temp/netprobe_https.as  --manifest temp/netprobe.build.json --run
```

Measured results (all pass):

| Check | Result |
|---|---|
| GET | `open;progress;httpStatus(200);complete;`, `data` = `hello-from-net` |
| Event order | `open`→`progress`→`httpStatus`→`complete` (`httpStatus` is **after** `progress` and before `complete`; §6.4/§6.7) |
| GET + `data` | folded into the query: the server receives exactly `?x=1&y=2` |
| POST | `httpStatus(200);complete;`, the server echoes the body `name=alice&city=paris` |
| 404 | `httpStatus(404);complete;`, `data` = `not found` (**an HTTP error status is a normal response, not converted to `ioError`**) |
| `dataFormat=binary` | `data` is a `ByteArray` of length 14 |
| Connection refused (port 9) | `ioError`, **no hang** (`CONNECTTIMEOUT` 10s / `TIMEOUT` 30s) |
| Real HTTPS | `open;httpStatus(200);complete;`, 559 B of `<!doctype html>` (TLS managed by the system libcurl) |
| Real HTTPS 404 | `httpStatus(404);complete;` |

**Reverse comparison on the same generated C** (proving the fork is only at the build layer, not in the
generated C):

```sh
cc -O2 temp/netprobe.c -lm -lz -o temp/netprobe_nobackend   # no -D ASC_HAVE_CURL, no -lcurl
./temp/netprobe_nobackend
# → GET log=httpStatus(0);ioError(URLLoader: network URLs are not supported in this build ...); data=empty
```

**Already completed (eighty-nine / fifty-one)**: the `mxmlc + adl` baseline comparison → §6.7; response
headers/effective URL/redirect count → §6.4; chunked progress (replayed `progress`) → §6.4. **Still not done**:
proxy, cookie jar, HTTP/2.

### 6.3 Stage F (`URLStream` streaming) acceptance — **executed (stage eighty-nine / fifty-one)**

Probe `temp/netprobe3.as` (native, the same server's `/drip` route: chunked `6 × 128 B`, slow-sent, 768 B total):

```sh
python3 temp/netprobe2_server.py 8732 &
node src/index.ts temp/netprobe3.as --manifest temp/netprobe2.build.json --run
```

| Check | Result |
|---|---|
| Incremental visibility | `bytesAvailable` is `> 0` on multiple frames (**6 read batches**, spanning 762–777 ms), rather than arriving all at once |
| Non-blocking read | when data is insufficient, reading `readUTFBytes(bytesAvailable)` does not block; the total after cross-batch concatenation = 768 |
| `readShort` sign extension | `0xC3 0xA9` at the same batch's tail gives `-15145` (`195*256+169-65536`) |
| `readUTF` length prefix | `readUTFBytes(2)` consumes the `u16` length, then reading 5 B gives `café`, with `bytesAvailable == 0` |
| `connected` / `close()` | after completion `connected == true` (AIR: **the stream is still connected** after completing, and the remaining bytes can still be read, until `close()`); only after `close()` does it become `false`; on a never-opened stream, `bytesAvailable`/`close()`/any `read*` throws `#2029` |
| Insufficient data | `EOFError` (asserting `#2030`) rather than silently returning 0 |
| Stream after failure | after `load` fails, `connected == true`, `bytesAvailable == 0`, `read*` → `EOFError #2030` ("opened but empty"), and `close()` works — consistent with the AIR measurement (`temp/air-probe` #3) |
| **Reverse comparison** | the same `temp/dbg2.as` **without `ASC_HAVE_CURL` declared** → `ioError` (text naming "this transport is not supported in this build"), **not masquerading as empty data** |
| web end | the same family of streaming assertions under the `fetch` backend passes all 6 batches, 768 B (§6.5's table, two rows) |

### 6.4 Stage C/D full contract acceptance — **executed (eighty-nine / fifty-one)**

Probe `temp/netprobe2.as` (native, `temp/netprobe2.build.json` = `link-libs: ["curl"]` +
`defines: ["ASC_HAVE_CURL"]`, with `targets.wasm` overridden to empty):

```sh
python3 temp/netprobe2_server.py 8732 &
node src/index.ts temp/netprobe2.as --manifest temp/netprobe2.build.json -o temp/out/native-netprobe2 --run
# → netprobe2: phase C/D assertions passed
```

| Check | Result |
|---|---|
| All verbs | `GET`/`POST`/`PUT`/`HEAD` (`HEAD` → no body, `bytesLoaded == 0`) all complete with status code 200 |
| Response headers | `responseHeaders` is a `URLRequestHeader` array containing `content-type`/`content-length`/the custom `x-custom` |
| `bytesTotal` | with a `Content-Length`, `bytesTotal == bytesLoaded == 14`; without one (chunked), it is the bytes received so far |
| Redirects | `followRedirects=true` → lands on the target body; `redirected == true` and `responseURL` is the **final** address |
| Header-block normalization | a mixed-case header name can be looked up case-insensitively (the parser normalizes to lowercase) |
| 4xx | `404` → `httpResponseStatus(404,…)`+`progress(9/9)`+`httpStatus(404)`+`complete`, `data` = `not found`; **an HTTP error status is a successful load**, and `ioError` is only for transport failure (§6.7 measurement) |
| Division of the two status events | `httpStatus` **carries only `status`** (`responseURL=null`, `responseHeaders` an empty array, `redirected=false`); only `httpResponseStatus` carries `responseURL`/`responseHeaders`/`redirected` |
| Non-HTTP loads | local files also end with an `httpStatus(0)` (AIR: `open;progress(n/n);httpStatus(0);complete;`) |
| `data` after failure | not `null`, but an **empty value** (`dataFormat=text` → an empty `String`; `binary` → an empty `ByteArray`) |
| Parameter validation | `load(null)` / `load(new URLRequest(null))` → two different `TypeError #2007` (`Parameter request/url must be non-null.`) |
| Progress replay | the byte watermark recorded by the background thread is **replayed** as multiple `progress` events before `complete` (the terminal event is still at the frame boundary) |
| No backend | the same generated C without `-D ASC_HAVE_CURL` → the first case fails on the honest `ioError` (reverse comparison) |

### 6.5 Stage E (web `fetch`) acceptance — **executed (eighty-nine / fifty-one)**

A web target cannot "run then read stdout" headlessly — so instead use a page that sends the assertions out
through three **independent channels**: POST back to the port (`/result` → file), a `TextField` on the page
(for a human reading the screenshot), and `window.__ascStdout` (the generated `index.html` buffers it via a
`Module.print` hook, which CDP reads for automation).

| File | Purpose |
|---|---|
| `temp/webprobe.as` | the web version of the same family of assertions (GET/404/POST+request headers/redirect/`URLStream /drip`/cross-origin CORS/`navigateToURL`) |
| `temp/webprobe.build.json` | `defines: ["ASC_USE_SKIA=1", "ASC_USE_WINDOW=1", "ASC_HAVE_FETCH"]` |
| `temp/run_webprobe.sh` | **one invocation** brings up everything: server + headless Chrome (`--no-proxy-server`) + CDP read-back; parameterized `DIR`/`RESULT`/`PAGE` so the reverse comparison can be run |
| `temp/cdp_eval.mjs` | CDP read/write (including `--pre` to install a probe before the page script, and `--nav` to navigate) |

```sh
export EMSDK_HOME=<repo>/build-tools/emsdk
node src/index.ts temp/webprobe.as --manifest temp/webprobe.build.json -o temp/out/webprobe/webprobe
bash temp/run_webprobe.sh          # → webprobe: DONE checks=15 failures=0
```

| Check | Result |
|---|---|
| GET three things | status code 200 + body + `bytesLoaded == 14` |
| 404 | `httpResponseStatus(404)` + `httpStatus(404)` + `complete`, `data` = `not found` (**an HTTP error status is a successful load**, not converted to `ioError`) |
| POST | the server echoes `POST:phase-e\|X-Test=web` — **both the body and the custom request header really went up** |
| Redirects | followed successfully and landed on the target body |
| `URLStream /drip` | 768 B arrive **in 6 batches** (really streaming, not all at once); after completion `connected == true`, and `close()` sets it `false` |
| Cross-origin (no CORS) | `ioError`, with text naming both the browser failure and `Access-Control-Allow-Origin` (**does not pretend success**) |
| `navigateToURL` | the page-side call returns without throwing; the `window.open` recorder the harness installed before the page script reads `["http://127.0.0.1:8732/hello", "mailto:someone@example.com"]` |
| JS-layer errors | `window.__ascErrors` is empty (no uncaught exception / unhandled rejection) |
| **Reverse comparison** | rebuilding the same page **without `ASC_HAVE_FETCH`** → the first case fails on the honest `ioError` (`checks=2 failures=2`), proving that macro is what turns on the backend |

**Landing points (pitfalls hit, to avoid recurrence)**:

- **`showWindow` "unwinds the stack"**: on web it calls `emscripten_set_main_loop(..., simulateInfiniteLoop)`,
  and the latter throws an `unwind` sentinel through `main` — **statements written after `showWindow` never
  execute**. The startup chain must run first, with `showWindow` last.
- **Do not use Emscripten JS library functions inside EM_ASM** (`stringToUTF8`/`lengthBytesUTF8`): the library
  functions are only linked into the build when the **compiled C** calls them, and reaching for them from
  EM_ASM gives a `ReferenceError` (measured). UTF-8

  encoding/decoding instead uses the built-in `TextEncoder` + `HEAPU8.set`, not depending on the Emscripten
  library.
- **A single-threaded `HTTPServer` + `HTTP/1.1` keep-alive will deadlock**: the server parks in one connection's
  processing loop, and when the browser opens a second connection (writing POST/GET in parallel) the request
  never arrives; use `ThreadingHTTPServer`.
- **Requests are only sent after a GUI-bearing `main`**, and request callbacks all rely on the frame-boundary
  drain (`as_web_fetch_pump` at the top of `as_async_tick`) — so you **cannot use a blocking spin to wait for
  results** (it starves the browser's promises); it must be event-driven.

### 6.6 Stage H (`navigateToURL`/`sendToURL`) acceptance — **executed (eighty-nine / fifty-one)**

| End | Evidence |
|---|---|
| native | `temp/netprobe4.as` → `netprobe4: phase H assertions passed`; pointing `ASC_OPEN_LAUNCHER` at a recorder script, it **receives 5 argv verbatim**, including `'http://127.0.0.1:8732/a; b$(id) && echo pwned'` **passed as-is** (`fork`+`exec` single argv, not via a shell, no injection) |
| WASI | `temp/wasi-nav.as` (`--target wasm --run`) → with no launcher environment it honestly reports `Error #2032`, not silently |
| web | see §6.5's last two rows (`window.open` recorded two URLs, including `mailto:`) |

### 6.7 Baseline comparison with `mxmlc + adl` — **executed (eighty-nine / fifty-two)**

The same `examples/url-test/src/Main.as` (login POST + stats GET + results on screen) is run once under the
**AIR reference implementation** (compiled with `$AIRSDK_HOME/bin/mxmlc` + run with `adl`) and once under
**this project** (`as-aot --air-app … --run`).
The AIR side is observed by **screenshotting the `adl` window** (`adl` swallows `trace()`, so the results are
only in the on-stage `TextField`), while this project's side reads stdout directly (native `trace` goes straight
out); both sides face the real `devapimeeting.talkmed.com`:

| Comparison item | AIR (mxmlc + adl) | This project (`--air-app --run`) | Match? |
|---|---|---|---|
| Login POST body and `Content-Type` | `application/json`, body `JSON.stringify({type,account,password,platform,language,appversion,timezone})` | same (same `Main.as`, same `net__prepare_request` path) | ✅ |
| Login response parsing | `code=0`, `data.accessToken` non-empty | `code=0`, `data.accessToken` non-empty | ✅ |
| Stats GET URL assembly | `…live_statistics?access_token=<token>&platform=…&language=…&appversion=…&timezone=8:00` | verbatim identical | ✅ |
| Stats `data` parsing | `{"code":0,"data":{"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68},"message":"success"}` | **byte-for-byte identical** | ✅ |
| Event sequence (`open`→`httpResponseStatus`→`httpStatus`→…) | `200` → `open` → … → `complete` (as in §6.7.1) | same | ✅ (text differs, event set is the same) |
| Two internet PNGs (`Loader.load`, stage eighty-nine / fifty-four) | both on screen: `753×751` / `815×814` scaled to width 340 (`340×339` / `340×340`) at `(10,60)` / `(370,60)`, `bytesTotal` `487042` / `511484` | item-by-item identical (including `bytesTotal` and the rounded scaled sizes) | ✅ |
| Image-load terminal event (same as left) | `INIT` → `COMPLETE`, `content` is a `Bitmap`, `numChildren == 1` | same (same `Main.as`, same `Loader__imageFinish`) | ✅ |
| Failure path (no backend) | — (AIR can always go online) | both requests land on the honest `ioError` (reverse comparison) | ✅ |

> Reverse comparison: running the same `.as` with the **default build** (no `ASC_HAVE_CURL`) → the first login
> lands on the honest `ioError` (`URLLoader: network URLs are not supported in this build …`), and the UI shows
> a failure rather than fake data, and **does not hang**. The `Loader` side is analogous: `Loader: network URLs
> are not supported in this build (no HTTP backend linked; see docs/zh-cn/flash-net.md)` — **distinguishable
> from the "file not found" text** (exactly the assertion `examples/loader-url.as` pins).

#### 6.7.1 Measurement record

**Run commands (both sides)**

```bash
# ① AIR reference implementation (mxmlc + adl)
SDK=/Users/ray.lei/Documents/Software/AIRSDK/AIRSDK_51.3.4   # note: 51.4.1's adl opens no window on macOS 26, so 51.3.4 is used
"$SDK/bin/mxmlc" -source-path+=examples/url-test/src -output examples/url-test/main.swf examples/url-test/src/Main.as
"$SDK/bin/adl" examples/url-test/url-test-app.xml -- examples/url-test   # after the window opens, screenshot and read the TextField

# ② this project (AIR descriptor direct compile + run)
#    curl arguments are no longer hand-typed: --air-app scans src, discovers URLRequest/flash.net, and writes them into the generated manifest automatically
node --experimental-strip-types src/index.ts --air-app examples/url-test/url-test-app.xml \
     -o temp/out/url-test/main
script -q /dev/null ./temp/out/url-test/main > temp/url-test-aot.log   # a pty makes trace line-buffered, so SIGKILL does not lose the tail
```

**This project's side, stdout (`temp/url-test-aot.log`, long JSON truncated)**

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

**AIR side, the `adl` window (screenshot `temp/air-urltest-window.png`, TextField text)**

```
…login response:
{"code":0,"data":{"accessToken":"a4fe9f8b-2fe6-507e-460a-8844c706e758",…,"needResetPassword":1,…},"message":"success"}

[login] accessToken = a4fe9f8b-2fe6-507e-460a-8844c706e758

[stats] GET https://devapimeeting.talkmed.com/v1/user/live_statistics?access_token=a4fe9f8b-…&platform=wechat_small&language=zh_CN&appversion=1.9.10&timezone=8:00
[stats] response:
{"code":0,"data":{"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68},"message":"success"}

=== done ===
```

**Conclusion**: the two sides' `accessToken` values differ (the server issues a new one each time, as
expected); **apart from `accessToken`, the flow and the `data` payload are item-by-item identical** — the stats
response `{"code":0,"data":{…"creator_live_total":56,"watcher_live_total":156,"speaker_live_total":68…},"message":"success"}`
is **byte-for-byte identical** on both sides.

**Reverse-comparison output (no `ASC_HAVE_CURL`)**

```
=== url-test: TalkMed login + live_statistics ===

[login] POST https://devapimeeting.talkmed.com/v1/login
[login] failed: ioError  [Event type="ioError" bubbles=false cancelable=false]
```

> **Pitfall record**: `adl`'s `trace()` does not go to stdout (only the window can be screenshotted), and
> `File.applicationStorageDirectory` is not writable in this adl environment — AIR probes always write
> **absolute paths** with `FileStream.open()`. Also: on macOS 26, AIRSDK 51.4.1's `adl` runs but creates no
> window (the Quartz window list is empty); switching to 51.3.4 restores normal behavior.

#### 6.7.2 Comparison of the two internet PNGs (stage eighty-nine / fifty-four)

The same `examples/url-test/src/Main.as` has two more `Loader.load(URLRequest)` steps appended (two
`https://meeting.talkmed.com/img/*.png`), run once on each side as before:

```bash
# this project's side: one command suffices (curl is auto-mounted by --air-app, see §6.7.3)
node src/index.ts --air-app examples/url-test/url-test-app.xml -o temp/out/url-test/url-test
```

The **equivalent form** of hand-typed arguments (the shape at stage eighty-nine / fifty-four, still usable now,
just no longer necessary):

```bash
node src/index.ts --air-app examples/url-test/url-test-app.xml \
     -I vendor/curl/include -L vendor/curl/lib/macos-arm64 -l curl -l nghttp2 \
     -D ASC_HAVE_CURL --framework Security --framework SystemConfiguration \
     -o temp/out/url-test/url-test
```

**Both sides' logs (the `[img]` lines) are verbatim identical** (only the completion order occasionally
differs, as the two images are parallel on two workers):

```
[img] loading 2 PNGs from meeting.talkmed.com ...
[img] GET https://meeting.talkmed.com/img/meeting_3.0bca6577.png
[img] GET https://meeting.talkmed.com/img/meeting_2.6e101b24.png
[img] meeting_3.0bca6577.png 753x751 decoded, scale=0.452 -> 340x339 at (10,60)  bytesTotal=487042
[img] meeting_2.6e101b24.png 815x814 decoded, scale=0.417 -> 340x340 at (370,60)  bytesTotal=511484
[img] 2/2 images on stage
```

**Screenshots**: AIR `adl` → `temp/out/adl-urltest-merged.png`, this project's AOT → `temp/out/aot-urltest.png`
(both show the two images side by side at `y=60`, with the corresponding log `TextField` below; this project's
side has an `Fps` overlay at the top, and `RUNTIME:AS-AOT` vs adl's `RUNTIME:Adobe M…` are the same
`Capabilities.manufacturer` field).

**Conclusion**: `bytesTotal` (`487042` / `511484`), the decoded sizes (`753×751` / `815×814`), the scale factors
and the rounded final sizes (`340×339` / `340×340`), and the positioning are all **item-by-item identical** to
AIR. The act of rendering to screen itself exposed the **real bug** fixed in stage eighty-nine / fifty-four:
with only `loader.content` filled, both sides' logs are identical, yet on the AOT side the two images **draw not
a single pixel** (adl can draw them, because AIR's `Loader` adds the content as its own child to begin with).

#### 6.7.3 The transport layer is auto-mounted by `--air-app` (stage eighty-nine / fifty-five)

A **build-layer** gap exposed when re-checking against "the command a user can type directly":

```bash
node ../../src/index.ts --air-app ./url-test-app.xml --main-class Main --target native --run
```

Running it gives **`ioError` for all network access** — the runtime is not wrong (§6.7.2 already proved remote
URLs go through the same seam), the problem is that **the generated manifest has no curl**: `ASC_HAVE_CURL` is
an opt-in macro (§3.4.1), and previously it could only be supplied by hand-typing CLI arguments; and the route
of "writing the arguments into `url-test.build.json`" **does not survive the next build** — `--air-app` rewrites
that file on every run (measured: change it, run again, and the md5 is back to the version without curl).

**Fix**: `src/air-app.ts` gains `detectNetworking(asFiles)` (same shape as `detectStage3D`), which scans the
app's own source for `URLRequest` — on a hit it automatically writes `-I/-L vendor/curl/…` + `-l curl -l nghttp2` +
`Security`/`SystemConfiguration` + `ASC_HAVE_CURL=1`; for the web target it writes `ASC_HAVE_FETCH=1`; and on
native, if `vendor/curl` is missing it **errors immediately** and points to
`build-tools/curl-src/build-static.sh`.
The criterion is `URLRequest`, **not** `import flash.net.*`: in AS3 **every** path through the HTTP seam
necessarily constructs a `URLRequest` first (`URLLoader.load` / `URLStream.load` / remote `Loader.load` /
`navigateToURL`), while the `flash.net` package also holds `SharedObject`/`FileReference`/`LocalConnection`,
classes that never touch the network — matching by package name would needlessly link 1.4 MB of static curl and
would block an app that only wants local storage on a machine without `vendor/curl` built.
`Socket`/`XMLSocket` (needing `ASC_SOCK_POSIX`) and `NetConnection`/`NetStream` (RTMP) are all **not** criteria
either.

**Measured (the user's original command, without a single extra argument)**: the login POST + stats GET + two
PNGs **all succeed**, and the two `[img]` lines are verbatim identical to §6.7.2 (`bytesTotal` **487042** /
**511484**, `753x751` / `815x814` → `340x339` / `340x340` @ `(10,60)` / `(370,60)`, `2/2 images on stage`); the
screenshot `temp/out/aot-autocurl.png` (frame header `FPS:120 MEM:4MB … RUNTIME:AS-AOT`, the two images side by
side at the top, with the same log in the `TextField` below). The generated manifest is **item-by-item
equivalent** to the hand-typed CLI arguments (the extra `vendor/curl` points at static libraries on both sides,
so `otool -L` still has no `libcurl.4.dylib`).

**Reverse comparison** (`test.ts`'s `checkAirAppTransport()`, 10 `[air-app]` assertions): an app that does not
touch the network **must not** be stuffed with curl (guarding against the over-fix of "always mount"; that
fixture **deliberately** does `import flash.net.SharedObject`, pinning down the wrong solution "match by package
name"); and the same networked app's web manifest must **switch to** `ASC_HAVE_FETCH=1` with no curl field at
all (`wasm-ld` cannot find `-lcurl`).

#### 6.7.4 Two gaps on the web target + one hard browser boundary (stage eighty-nine / fifty-six)

The acceptance of stages eighty-nine / fifty-four and fifty-five was all done on native and `adl`; when the user
ran the same `examples/url-test` in a **browser**, what they saw was: the login rejected by the server, and both
images erroring without a single byte downloaded. Both are **real gaps**, and both fail **looking like the app's
own bug** (which is also why they survived so long).

```bash
node ../../src/index.ts --air-app ./url-test-app.xml --main-class Main --target wasm --package web
```

**Gap 1: the web backend drops `URLRequest.contentType`.** Native's `as_http_perform` turns it into a
`Content-Type:` header, but web's `as_web_fetch_go` **never used `j->content_type`** — and `fetch` only adds that
header automatically for `string`/`Blob` bodies, never for the `Uint8Array` this backend passes. So on a real
endpoint it yields (measured inside the browser, same-origin JSON body):

| Request | Server response |
|---|---|
| `POST` + `Uint8Array` body, **no** Content-Type | `{"code":200002,"message":"platform field is required"}` |
| The same request + `Content-Type: application/json` | `{"code":0,"data":{"accessToken":"1b394084-…"}}` |

**Fix**: `as_web_fetch_go` gains a `ctype` parameter, computed on the C side by `as_web_ctype()` per the **same
rule** as native (`content_type != NULL && (POST || has body)`), written **before** the explicit
`requestHeaders` block, so a same-named header in `URLRequest.requestHeaders` still takes precedence. Both
entry points (`as_http_run` / `as_http_stream_run`) pass it, keeping URLLoader and URLStream consistent.

**Gap 2: remote images have no transport on web.** `as_job_run`'s `AS_JOB_IMAGE_URL` branch had only one
implementation, `#if defined(ASC_HTTP_BACKEND)` (= curl), so on web it fell to the `#else`
`AS_JOB_ERR_UNSUPPORTED` — reporting "this build has no HTTP backend linked" (stage eighty-nine / forty-nine
stage G's honest text), when **this build actually does**. So every remote `Loader.load` on web failed **without
sending a single request**. The fix adds `#elif defined(ASC_HTTP_WEB)` to that branch: `as_http_run(j)` only
**starts** the fetch and leaves the job in RUNNING (`pending_async`, so `as_job_publish` does not mark it DONE
and the thunk does not run), and once the body arrives `as_web_fetch_pump` decodes it on the terminal entry —
producing **item-by-item identical** to the curl branch: the pixels BitmapData needs and the encoded bytes the
display SkImage needs. Decoding happens at the frame boundary (the browser has no worker thread to hide it in;
a few ms per frame, one image per job).

**Hard boundary: these two URLs should **not** be readable on web.** `meeting.talkmed.com`'s image response has
**no** `Access-Control-Allow-Origin` (only `timing-allow-origin: *`). A cross-origin image can be **displayed**
in the browser, but its **pixels cannot be read** (the canvas gets tainted), and rendering to Skia needs the
pixels — so this is not a boundary the compiler can work around. Measured in real Chrome: `fetch()` of that URL
in the same page → `Failed to fetch`; `curl` of the same URL → 200 + the full 487042 bytes (`curl` is not bound
by the same-origin policy). **This is exactly the only reason native/adl works while web does not.**

**Measured (real browser, one URL per stage)** — `temp/webimg-air` (fixture) + `temp/run_webimg.sh`, the server's
only difference being whether there is a CORS header:

| Case | Result |
|---|---|
| Same-origin (the page's own 8732) | `[ok] same-origin decoded 753x751 bytesTotal=487042` |
| Cross-origin, server returns `ACAO:*` | `[ok] cross-origin+CORS decoded 815x814 bytesTotal=511484` |
| Cross-origin, **no** CORS header | `[ioError] cross-origin-NO-CORS #0 fetch failed (Failed to fetch); for a cross-origin URL this is usually a missing Access-Control-Allow-Origin header` |
| canvas pixels (non-white points counted per band) | `720x900 band1=47027 band2=45429 band3=0` — the first two bands really drew, the third not a single point |

**Measured (the user's app, `examples/url-test`, `temp/run_urltest_web.sh`** — the server marks `.wasm` as
`application/wasm`, so the run log has no streaming-compilation fallback lines): the login POST obtains an
accessToken (`[login] accessToken = 531d9f5c-…`), the stats GET returns
`{"code":0,"data":{"creator_live_total":56,…}}` (**before the fix this was never even sent**), and both images
each get the CORS-naming `ioError` above; `window.__ascErrors` is empty. The only remaining difference from the
native side is that one image item, and the cause is the CDN's same-origin policy.

**Reverse comparison**: `test.ts`'s `checkWebTransport()`, 4 `[web]` assertions (the suite has no browser and no
emcc, so they pin the **contract** in the runtime preamble, and each has already had a reverse comparison done:
removing the web image branch / removing Content-Type / removing the pump decode each immediately turns the
corresponding assertion false).

#### 6.7.6 The terminal state of non-2xx: a controlled measurement (stage eighty-nine / sixty-two)

**Background**: the leftover table's entry "`URLLoader`/`URLStream` unconditionally `complete` for 4xx" drew its
conclusion from comparing two probe sets; but between the two sets, **besides the listener, the host/protocol/
`Content-Length` also changed**, which is insufficient to attribute the difference to the listener. So it was
redone as a **controlled** experiment: the same local server, the same URL, the same bytes, with **the only
variable being whether the caller registers `HTTP_RESPONSE_STATUS`**. `HTTP_STATUS` is registered in every cell,
to prove the criterion is **that event type** and not "any status listener".

Tools: `temp/httpstatus-probe/` (`server.py` + an adl probe), `temp/httpstatus-probe2/` (empty body + both
halves of `URLStream`), `temp/httpstatus-aot/httpstatus-aot.as` (an AOT version of the same matrix),
`temp/httpstatus-probe/run_all.sh` (bringing up a clean server once → health check → running adl then AOT on
**the same instance**). All 12 cells are **verbatim identical on both sides**:

| # | Request | Listener | Terminal state | Sequence (adl and AOT identical) |
|---|---|---|---|---|
| A | 404 + body | yes | `complete` | `open;httpResponseStatus(404,redir=false);progress(10/10);httpStatus(404);complete` |
| B | 404 + body | **no** | **`ioError #2032`** | `open;progress(10/10);httpStatus(404);ioError(2032)` |
| C | 500 + body | yes | `complete` | `open;httpResponseStatus(500,redir=false);progress(13/13);httpStatus(500);complete` |
| D | 500 + body | **no** | **`ioError #2032`** | `open;progress(13/13);httpStatus(500);ioError(2032)` |
| E | 200 + body | no | `complete` | `open;progress(15/15);httpStatus(200);complete` |
| F | 302 no-follow | yes | `complete` | `open;httpResponseStatus(302,redir=false);httpStatus(302);complete` |
| G | 302 no-follow | **no** | **`ioError #2032`** | `open;httpStatus(302);ioError(2032)` |
| H | 302 follow | no | `complete` | `open;progress(15/15);httpStatus(200);complete` |
| I | 200 empty body | no | `complete` | `open;httpStatus(200);complete` |
| J | 404 empty body | no | `ioError #2032` | `open;httpStatus(404);ioError(2032)` |
| K | `URLStream` 404 | yes | `complete` | `open;httpResponseStatus(404,redir=false);progress(10/10);httpStatus(404);complete` |
| L | `URLStream` 404 | **no** | **`ioError #2032`** | `open;progress(10/10);httpStatus(404);ioError(2032)` |

**Three easy-to-get-wrong rules read out of the matrix**:

1. **The threshold is `status >= 300`, not 4xx**. An unfollowed 302 forks the same way (F/G). Implementing it as
   "4xx" would treat a redirect that AIR reports as `ioError` as a success.
2. **The error body is published as usual on both halves**, and `data` and `bytesLoaded/bytesTotal` are **already
   filled** on the `ioError` branch too (B/D are both `data=String(not found\n)`, `bytes=10/10`). The fork point
   is **only the last event**: `progress` → publish → after `httpStatus`, `complete` ⇄ `ioError`. Making the
   failure branch "not publish, zero `bytes`" (which this project's failure branch originally did) would change
   one extra byte.
3. **An empty body dispatches no `progress`** (I/J). The terminal supplementary `PROGRESS` needs a `total > 0`
   guard — this rule is a difference **newly discovered** by the controlled experiment (previously the
   implementation supplemented unconditionally, adding an extra `progress(0/0)` for an empty body).

**Implementation**: `URLLoader__finish` / `URLStream__finish` each fork after `httpStatus` —
`status >= 300 && !EventDispatcher_hasEventListener(o, "httpResponseStatus")` (the criterion, like AIR's, is
"has a listener at any phase"), and the error branch uses `as_ioerror_text(path, 2032, NULL)` to get the **AIR
original text** (`Error #2032: Stream Error. URL: <url>`), sharing the formatter with the eighty-nine /
fifty-nine set. **Reverse comparison**: `test.ts`'s 6 `[httpstatus]` assertions have had four mutation groups
done (threshold changed to 400 / remove the `!` / change only one `URLStream` cell / change a cell's number to
2030), each turning **only** the corresponding assertion red; the empty-body guard also has an **offline
end-to-end** comparison (`examples/urlloader-contract.as` reading `examples/empty.bin`; removing `total > 0`
reports `open;progress;complete;`).

> **Another methodological lesson**: this round's probe `server.py` was initially **single-threaded + HTTP/1.1
> keep-alive**, and one connection hung it dead, failing all subsequent requests — which looks exactly like "the
> transport is broken" (all 10 cells `httpStatus(0);ioError`). Switching to `ThreadingHTTPServer` + HTTP/1.0 and
> **health-checking** before each measurement is what produced the table above.
> **When the instrument is untrustworthy, the conclusion must be untrustworthy** — the same lesson as fixing
> `netprobe2_server.py` in §6.7.4.

#### 6.7.5 `ioError`'s error number and text (stage eighty-nine / fifty-nine)

**Background**: the user asked "is SVG covered in the TODO", and the investigation found **zero SVG coverage in
the TODO**, and per the
[`Loader` class documentation](https://airsdk.dev/reference/actionscript/3.0/flash/display/Loader.html)
three places (class description / `load()` / `loadBytes()`), **AIR's `Loader` only supports SWF/JPG/PNG/GIF** —
SVG was never in scope (Flash Pro's SVG import is an authoring-time conversion, not runtime decoding). Measuring
with real `adl` confirms AIR also reports ioError for SVG, so "we error" is correct; the user chose to **fix
only the one bug this investigation brought out** (SVG support is a separate matter).

**The bug**: every `ioError` the runtime **generates itself** carries `e.errorID == 0`, with `text` being a
single hand-written sentence. The root cause is that `IOErrorEvent_ctor` fixes `errorID` at 0 (correct for
`new IOErrorEvent(...)`, as AIR's constructor does not accept an error number; for runtime-generated internal
events it is a missing fill), and all three dispatch points (`Loader`/`URLLoader`/`URLStream`) use the
constructor directly without assigning. The `Socket` path already had `Socket__ioerror_event` filling `#2031`,
so this was clearly an omission.

**AIR measurement matrix** (`adl` 51.4.1; probes `temp/svg-air/` and `temp/svg-air2/`, writing results to
**absolute paths** — `adl` swallows `trace()`). These numbers are never listed in AIR's docs and can only be
measured:

| API | Failure scenario | `errorID` | `text` (verbatim) |
|---|---|---|---|
| `Loader` | local file does not exist | `2035` | `Error #2035: URL Not Found. URL: <url>` |
| `Loader` | payload is not an image (HTTP 2xx) | `2124` | `Error #2124: Loaded file is an unknown type. URL: <url>` |
| `Loader` | transport failure (DNS / refused connection) | `2036` | `Error #2036: Load Never Completed. URL: <url>` |
| `Loader` | **HTTP ≥ 400** (e.g. a 404 error page) | `2036` | same as above |
| `URLLoader` | any failure | `2032` | `Error #2032: Stream Error. URL: <url>` |
| `URLStream` | any failure | `2032` | same as above |
| `Socket` | any failure | `2031` | `Error #2031: Socket Error. URL: <url>` |

**The easiest cell to get wrong**: a remote 404 reports **`2036`**, not `2124`. The 404 response body (an HTML
error page) really does reach the decoder and fails there, so translating "decode failure → 2124" literally
would report "the server says there is no such file" as "this is not an image". The determination must combine
the staged HTTP status: the same decode failure gives `2036` when `status >= 400`, and `2124` otherwise.

**Verbatim comparison on both sides** (probes `temp/ioerr-matrix.as` / `temp/ioerr-matrix2.as`, manifest
`temp/ioerr-matrix.build.json`):

| Input | AIR (`adl`) | This project (before fix) | This project (after fix) |
|---|---|---|---|
| `https://airsdk.dev/images/crossplatform.svg` (200, not an image) | `2124` | `0` | **`2124`** ✅ |
| `https://airsdk.dev/no-such-file-xyz.png` (404) | `2036` | `0` | **`2036`** ✅ |
| `https://no-such-host-xyz.invalid/a.png` (DNS) | `2036` | `0` | **`2036`** ✅ |
| `file:///no/such/dir/absent.png` | `2035` | `0` | **`2035`** ✅ |
| `/no/such/dir/absent-plain.png` | `2035` | `0` | **`2035`** ✅ |
| `temp/svg-air/notimage.txt` (local non-image) | `2124` | `0` | **`2124`** ✅ |
| `URLLoader` / `URLStream` local missing, DNS, 404 | `2032` | `0` | **`2032`** ✅ |

**Text shape**: `Error #N: <sentence>. URL: <url>` — the number's own sentence plus the offending URL, matching
every cell of the table above. When a backend has extra detail (web's `fetch` gives a note naming CORS and the
response category) it is **parenthesized after the sentence** rather than replacing it: AIR has no such
information (it can always go online), but dropping it would make "blocked by CORS" look like "the server is
dead".

**The one kind given no number**: "this build has no HTTP backend linked" (stage G) is a property of the
**build artifact**, and AIR has no such state, so `errorID` stays `0` and the text stays a build-level sentence.
Inventing a number would be worse than leaving 0 — callers `switch` on numbers.

**One unaligned point (not this defect)**: AIR normalizes a relative path into `app:/no/such/dir/absent.txt`
before putting it into the text; this project uses the URL passed in as-is. This is URL-parsing behavior,
unrelated to this defect, and is recorded in the TODO leftover table.

**Offline-reproducible end-to-end assertions**: `examples/loader-url.as` (local non-image → `#2124` with text
**verbatim equal**; local missing → `#2035` with verbatim equality; no backend → the number stays `0`) and
`examples/urlloader-contract.as` (local missing → `#2032` with verbatim equality). The two cells needing a real
network (transport failure, a 4xx response) are pinned on `test.ts`'s `checkIoErrorFidelity()` structural
assertions.

> **That separate defect has been fixed (stage eighty-nine / sixty-two)**: AIR's terminal state for non-2xx
> indeed depends on whether the caller has registered an `HTTP_RESPONSE_STATUS` listener, and it is now
> implemented accordingly — **with** that listener → the error-page body is dispatched as content via
> `progress`/`complete`; **without** it → after `httpStatus(status)`, `ioError #2032` (the error-page body is
> **published either way**, and `bytesLoaded/bytesTotal` are the same on both halves).
>
> An earlier note in this section, "measured 404 against two different hosts", has a **methodological flaw**: the
> two probe sets changed the host, protocol and `Content-Length` along with the listener, so the difference
> cannot be attributed to the listener. Eighty-nine / sixty-two redid a **controlled** experiment (same server,
> same URL, same bytes, the only variable being that listener) and corrected the threshold from "4xx" to
> "`status >= 300`" — an **unfollowed 302** forks the same way. The full 12-cell matrix is in §6.7.6.

#### 6.7.7 `URLRequest.contentType` is **two** things: the property value vs the send default (stage eighty-nine / sixty-nine)

**The symptom is not "the property value is wrong", it is "the demo never started".** `examples/air-native`
builds successfully with `--air-app ./air-native-app.xml --target native --run`, prints `Build successful`, but
the process **ends with exit code 1 after 0.053 s and the window never appears**. The root cause is that
`NetUiDemos.run()`'s `Assert.check(req.contentType == null, ...)` throws an uncaught exception, cutting the
whole demo off at stage 63.

**Two contradictory contracts, and both must be measured.** Stage eighty-nine / forty-eight, following the
official docs, wrote the constructor as `o->contentType = "application/x-www-form-urlencoded"` and synchronized
`examples/stage63.as`; but the AS3-side property value measured in adl is `null`. The truth is that the
document's sentence describes the **send default**, not the getter:

| Probe (mxmlc + adl 51.3.4 + a local capture server) | AS3 reads back | `Content-Type` adl actually sends |
|---|---|---|
| `new URLRequest(url)` | **`null`** | — |
| `req.contentType = ""` | **`""`** (not normalized to `null`) | — |
| set `"application/json"` then set `null` | `null` | — |
| POST with a body, contentType unset | — | `application/x-www-form-urlencoded` |
| POST with a body, contentType = `""` | — | `application/x-www-form-urlencoded` |
| POST with a body, contentType = `"application/json"` | — | `application/json` (as-is) |
| POST with **no body** (`Content-Length: 0`) | — | **none sent at all** |
| GET (`data` folded into the query string) | — | **none sent at all** |

**Conclusion**: the trigger condition is "**the body is non-empty**", not "it is a POST". The fix is to **split
into two layers** — the property (`URLRequest_ctor`) goes back to `NULL`; the send contract is centralized in the
shared helper `as_http_effective_ctype(j)` (shared by the curl and web backends, to prevent drift between them).

**Reverse comparison (the same probe on the AOT side, comparing captured headers item by item, 6/6 match)**:

| Case | adl | AOT before fix | AOT after fix |
|---|---|---|---|
| POST with a body, contentType unset | `application/x-www-form-urlencoded` | ✅ same | ✅ same |
| POST with a body, contentType = `""` | `application/x-www-form-urlencoded` | ✅ same | ✅ same |
| POST with a body, explicit `application/json` | `application/json` | ✅ same | ✅ same |
| POST with no body | **no header** | ❌ sent urlencoded | ✅ no header |
| GET (no body) | no header | ✅ no header | ✅ no header |

That last divergence comes from **libcurl itself**: it adds `Content-Type: application/x-www-form-urlencoded` to
every POST, whereas adl does not. So for a bodyless POST an **empty-value** entry is appended
(`curl_slist_append(hdrs, "Content-Type:")`) — this is how libcurl suppresses its built-in default header. On
the web side `fetch` does not self-add one for a `Uint8Array` body, so no handling is needed.

**Why the old regression did not catch it**: `examples/air-native` is a **directory-style example**, and
`test.ts` only compiles it, **does not run it**; and among the three examples that could assert the default,
only it puts the assertion on a path that gets executed. So this stage adds a `[req-ctype]` group to `test.ts`
(6 items): pinning the property default, pinning the shared send rule, pinning the suppression of libcurl's
default header, and **scanning every `contentType ==` line under `examples/` that claims to assert a "default"
and requiring it to be consistent with what the constructor emits** — precisely the general nail for defects
like "the default was changed but the example was missed".

### 6.8 Three-target consistency acceptance

- ✅ **The same manifest really compiles across targets (stage eighty-nine / fifty)**: one manifest,
  `examples/flash-net-layered.build.example.json` → native really links `/usr/lib/libcurl.4.dylib` and runs
  correctly; the same manifest with `--target wasm` links **zero curl** and runs line-for-line identically to
  native (`strings <wasm> | grep -ic curl` = 0). This lifts the constraint recorded by the stage eighty-nine /
  forty-nine probe, "the same manifest fed to wasm fails outright" ([`compile.md`](compile.md) §4.1).
- ✅ **native and WASI consistent (stage eighty-nine / forty-nine)**: the same
  `examples/urlloader-network-unsupported.as` behaves identically under native and wasm32-wasip1 (both dispatch
  a **distinguishable** honest `ioError` with no backend).
- ✅ **web backend semantic alignment (eighty-nine / fifty-one)**: native and web run **the same family of
  assertions**, aligned item by item (§6.4 vs §6.5); the differences between the two ends are **only at real
  differences** (web's CORS refusal, lowercase response header names, unobservable redirects), all documented
  rather than smoothed over with make-believe.
- Still pending: automated **byte-for-byte consistency** regression when all three ends **simultaneously** have
  a backend (currently relying on two probe sets' same-family assertions + manual comparison).

---

## 7. `Socket` / `SecureSocket` / `ServerSocket` / `XMLSocket` (stage eighty-nine / fifty-three)

> Every semantic in this section comes from a **measurement** with `mxmlc + adl` (probe
> `temp/air-probe/Probe11.as` → `air-probe11-result.txt`), not inference from documentation; **branches not
> measured are explicitly marked below**.

### 7.1 Landed surface (implemented)

| Class / member | Current state |
|---|---|
| `Socket` (an `EventDispatcher` subclass) | ✅ `connect(host,port)`/`close()`/`flush()` + complete `IDataInput`/`IDataOutput` (`readBoolean/Byte/UnsignedByte/Short/UnsignedShort/Int/UnsignedInt/Float/Double/UTFBytes/UTF/MultiByte/Bytes` and the corresponding `write*`) + properties `endian`/`objectEncoding`/`timeout`/`tcpNoDelay` + read-only `bytesAvailable`/`bytesPending`/`connected`/`localAddress`/`localPort`/`remoteAddress`/`remotePort` |
| `ServerSocket` | ✅ `bind(localPort=0, localAddress="0.0.0.0")`/`listen(backlog=0)`/`close()` + read-only `bound`/`listening`/`localAddress`/`localPort` + static `isSupported`; dispatches `ServerSocketConnectEvent.CONNECT` (carrying `socket`). **Plus an added synchronous `accept()`** (AIR lacks this method, see the last row of 7.2) |
| `XMLSocket` | ✅ `connect(host,port)`/`close()`/`send(obj)` + read-only `connected`/`timeout`; inbound frames by NUL dispatch `DataEvent.DATA`, with `data` being a **String** (measured) |
| `SecureSocket` | ⚠️ **API surface only + honest failure**: `isSupported` always `false`, `connect()` dispatches `ioError #2031`. TLS state machine not implemented (see 7.3) |
| `IOError` (`flash.errors`) | ✅ new (the carrier of `#2002`, alongside the existing `EOFError #2030`) |
| `ServerSocketConnectEvent` / `OutputProgressEvent` | ✅ new (`CONNECT`/`OUTPUT_PROGRESS` + `socket` / `bytesPending`/`bytesTotal`) |
| `ProgressEvent.SOCKET_DATA` | ✅ new (`"socketData"`) |
| `DatagramSocket` (UDP) | ❌ not implemented (a different base from TCP, a standalone effort) |

### 7.2 AIR measured semantics (the basis for alignment)

| Scenario | Measurement (`adl`) |
|---|---|
| Newly constructed object | `connected=false`; `bytesAvailable`/`bytesPending`/`close`/`flush`/`read*`/`write*` **all throw `IOError #2002 "Error #2002: Operation attempted on invalid socket."`**; `endian="bigEndian"`, `objectEncoding=3`, `timeout=20000`, `tcpNoDelay=false`, `localAddress=null`, `localPort=0`, `remoteAddress=null`, `remotePort=0`. `ServerSocket.bound=false`/`listening=false`; `XMLSocket.connected=false`/`timeout=20000` |
| Bad parameters | `connect(null,80)` → `TypeError #1009`; `connect("127.0.0.1",70000)` → `SecurityError #2003 "Invalid socket port number specified."` |
| Connection refused / DNS failure | `connect()` **returns normally** (does not throw), then dispatches `ioError`: `errorID=2031`, `text="Error #2031: Socket Error. URL: <host>"` (**host only, no port**) |
| Loopback echo | `bind(0)` → `bound=true`, `listening=false`, `localPort=<ephemeral port>`, `localAddress="0.0.0.0"`; `listen()` → `listening=true`; when `connect()` returns `connected=false` (only `true` on the next frame); the server dispatches `ServerSocketConnectEvent.CONNECT` (**no `accept()` needed**), and the accepted socket has `connected=true` with `remoteAddress`/`remotePort` filled; `writeUTFBytes("hello")` → `bytesPending=5`, `flush()` → `bytesPending=0`; `socketData`'s `bytesLoaded` = this chunk's byte count, `bytesTotal=0` |
| Close and reconnect | an idle connection reads `bytesAvailable` = `0` (does not throw); **reading with insufficient data → `EOFError #2030 "End of file was encountered."`**; `client.close()` → `connected=false`, after which reads/writes throw `#2002`; **the server receives `Event.CLOSE`**; `srv.close()` → `bound=false`/`listening=false`/`localPort=0`, and a further `listen()` throws `#2002`; **the same `Socket` object can `connect()` again** (`CONNECT` dispatched again, echo works normally) |
| `XMLSocket` framing | `send("hello")` actually sends **6 bytes** (5 payload bytes **+ an automatic NUL**) and **flushes immediately** (unlike `Socket`, which waits for `flush()`); an inbound NUL-terminated message dispatches `DataEvent.DATA`, with `data` a **String** (the NUL stripped); `send(XML)`/`send(String)`/`send(int→"42")`/`send(Object→"[object Object]")` all work, but **`send(null)` → `TypeError #1009`** |
| Reference surface (airsdk.dev `ServerSocket`) | the constructor takes **no arguments**; no `accept()`, no `timeout`; `bind` out-of-range `RangeError`, invalid address `ArgumentError`, already-bound/port-in-use `Error`; `listen` negative backlog `RangeError`, unbound `Error` |

> **The last row is this subset's only "addition"**: AIR's `ServerSocket` can only deliver connections via
> `ServerSocketConnectEvent`, whereas this implementation **also** provides `accept():Socket` (synchronously
> taking a pending connection). Both routes **deliver each peer only once** (`accept()` clears that connection's
> event bit when taking it), so the addition introduces no duplication.

### 7.3 Implementation contract (why it is done this way)

- **Non-blocking + frame-boundary polling** (corresponding to §4.2's "three-target fork"): all sockets share one
  `as_sock` registry, and at the frame boundary `as_async_tick_with(wait_ms)` runs one `as_sock_pump()` (one
  `poll(2)`) + `as_sock_dispatch()`. This is isomorphic to AIR's model of "everything dispatches between frames",
  needing no per-connection thread, no locks, and no cross-thread handoff, and it **maps directly onto WASI
  preview2's pollable model**. The wait only happens when "there is an in-flight connection or bytes pending
  flush" (`as_sock_in_flight()`), so headless does not hang.
- **GC roots**: `as_sock` is `malloc`ed (not a GC object), and its `obj` (the AS3 object) is registered as a
  **permanent root** via `as_sock_mark_roots()` (alongside the async IO job targets, hung off
  `gc_mark_internal_roots`).
- **Strict distinction between `#2002` and `#2030`**: before a read, first determine "is the socket still
  valid"; invalid goes `#2002`, valid-but-insufficient-data goes `#2030` — this is the easiest measurement
  point to get wrong (an early implementation conflated the two, and the test caught it immediately).
- **Write buffering + `flush()`**: `write*` only enters the buffer (`bytesPending` = the remainder), and
  `flush()` and the frame boundary push the bytes out; `outputProgress` is dispatched when bytes **really leave
  the queue** (corresponding to `OutputProgressEvent`).
- **`SecureSocket` does not pretend** (AGENTS.md §2.5): with TLS unimplemented it **never silently makes a
  plaintext connection**, instead giving `isSupported=false` + `#2031` with the measured text. What is really
  missing is "a TLS state machine on top of a non-blocking transport + AIR's `serverCertificateValidate`
  handshake", recorded in `TODO.md`'s leftover table.
- **DNS is synchronous** (`inet_pton` fast path → `getaddrinfo`): this is a **performance note**, not a semantic
  error — AIR also returns from `connect()` and then delivers the result by event, so this implementation's
  `connect()` likewise does not throw.
- **Not done**: AMF `readObject`/`writeObject` (this subset's `ByteArray` has no AMF, same batch as §3.2),
  `readMultiByte` ignoring `charSet` (consistent with this subset's `ByteArray.readMultiByte` contract, noted in
  a `symbols.ts` comment), `DatagramSocket`.
- **Targets with no POSIX socket** (WASI/Web/Windows): outside `ASC_SOCK_POSIX` it degrades to an honest
  `ioError` with `unsupported=1`, the same contract as §4.2's "no-network targets report honestly".

### 7.4 Acceptance

```sh
node src/index.ts examples/socket.as --run     # loopback echo + close/reconnect + XMLSocket + SecureSocket
node test.ts                                   # full regression (this example counts toward the 124 items)
```

`examples/socket.as` is **self-contained** (`ServerSocket.bind(0)` + local loopback, no external server
dependency), and its assertions cover: `#2002` in the unopened state, `connect` parameter errors, the loopback
echo's byte watermark and `socketData`, `#2002` after `close` and reconnection, `XMLSocket`'s NUL framing
(payload and terminating NUL **asserted separately** — this subset's String is NUL-terminated, so an embedded
NUL cannot be observed via `readUTFBytes`, hence two separate reads), and `SecureSocket`'s `isSupported=false` +
`#2031`.

---

## 8. Boundaries Explicitly Not Done / Deferred

| Item | Judgment |
|---|---|
| Cross-origin URL policy files, reserved-port restrictions | ❌ not done — those are Flash Player/browser sandbox constraints, and the desktop application sandbox (AIR application sandbox) has no such restriction to begin with |
| `certificateError` with `preventDefault()` let-through | ⏸ deferred (no UI to carry certificate interaction); failure lands as `ioError` |
| `URLRequestDefaults.setLoginCredentialsForHost` | ⏸ deferred (authentication scenario) |
| `Socket`/`SecureSocket`/`ServerSocket`/`XMLSocket` | ✅ **done, see §7** (`SecureSocket` only to API surface + honest failure: TLS state machine unimplemented, `isSupported=false`) |
| `DatagramSocket` (UDP) | ⏸ deferred (a different base from TCP: connectionless, no `flush` semantics, `send()` carries the target address) |
| `LocalConnection`/`NetConnection`/`NetStream`/`NetGroup*`/RTMP | ❌ not done (depends on FMS / audio-video, out of scope) |
| `FileReference`/`FileReferenceList` (file upload/download dialogs) | ⏸ deferred (depends on native file dialogs) |
| `registerClassAlias`/`getClassByAlias` (AMF) | ⏸ deferred (`SharedObject` is already modeled per AIR semantics; AMF serialization as needed) |
| HTTP/2, cookie jar, proxy | ✅ **done (stage eighty-nine / fifty-three)**: HTTP/2 = `ASC_HTTP2` (still 1.1 by default), cookie jar = process-level `CURLSH`, proxy = environment variables + the system proxy |
| gzip, HTTP caching, HTTP authentication | ⏸ as needed (gzip depends on the `zstd`/`brotli` trade-off beyond building `libz`; `setLoginCredentialsForHost` is still deferred) |

---

## 9. Workload and Conclusion

- **Workload**: **A/B (API surface completion) is "small-version magnitude"** (pure semantics layer, reusing the
  existing local jobs) — **delivered as measured**: stage eighty-nine / forty-eight landed within one patch
  version (`symbols.ts` + `emit.ts` + `runtime.ts`, 3 new helpers total), without changing any existing backend
  or build flow.
  **G + the C native probe is likewise patch-version magnitude** (stage eighty-nine / forty-nine): `runtime.ts`
  gains the `AS_JOB_HTTP` job kind + the network seam (about 145 lines), `emit.ts` changes
  `URLLoader_load`/`__finish` and generates `HTTPStatusEvent` (about 55 lines), with **zero changes to
  `build.ts`** (reusing the existing `link-libs`/`defines`).
  For comparison, **the full C→I is still "an independent heavy engineering project"**: the probe deliberately
  did only the "read it all at once" vertical slice, not yet touching chunked progress, response-header parsing,
  proxy/cookie, HTTP/2, the streaming `URLStream` job, web `fetch`, or static self-contained packaging (each of
  which is a large chunk).
- **Feasibility**: ✅ technically fully feasible. HTTP/1.1 is a standard protocol, TLS has mature libraries to
  link (§2.9 already permits it), and web's `fetch` is a native browser capability; the only "incompleteness" is
  WASI having no network — but that is an honest degradation to begin with.
- **Impact on the existing architecture**: the **only substantive impact** is §4.3's "streaming job" form
  (incremental progress / non-blocking reads). The one-shot job skeleton can be reused, without overturning the
  achievements of stage eighty-nine / forty-five.
- **The only thing to decide**: whether the full part beyond C is worth the investment. **A/B is done
  (eighty-nine / forty-eight)**, and **G + the native probe is done (eighty-nine / forty-nine)** — the probe uses
  real code to give three hard constraints: (1) using the system libcurl **breaks self-containment** (dynamically
  linking `libcurl.4.dylib`); (2) **the same manifest cannot cross targets** (`link-libs` is not
  target-conditional; feeding wasm fails to link outright); (3) fortunately **the generated C is the same** (the
  fork is only in `-D`).
  Of these, (2)'s build-layer prerequisite **was completed in stage eighty-nine / fifty** — once the
  build-manifest `targets` override block landed, "target-layered linking" no longer blocks D→I
  ([`compile.md`](compile.md) §4.1, measurement in §6.3).
  So **the only remaining decision is "whether to do C→I"**, which still depends on whether there is a use case
  that "really needs to load over the network" — if the goal is always "resources ship with the app", simply
  leaving `ASC_HAVE_CURL` undeclared is enough.

---

## 10. Reference Links

- [AS3 language reference — `flash.net` package](https://airsdk.dev/reference/actionscript/3.0/flash/net/package-detail.html)
- [`URLLoader`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoader.html) ·
  [`URLLoaderDataFormat`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLLoaderDataFormat.html) ·
  [`URLRequest`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequest.html) ·
  [`URLRequestMethod`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestMethod.html) ·
  [`URLRequestHeader`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestHeader.html) ·
  [`URLRequestDefaults`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLRequestDefaults.html) ·
  [`URLVariables`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLVariables.html) ·
  [`URLStream`](https://airsdk.dev/reference/actionscript/3.0/flash/net/URLStream.html)
- [`HTTPStatusEvent`](https://airsdk.dev/reference/actionscript/3.0/flash/events/HTTPStatusEvent.html)
- **Portability / same-shaped precedent** (§4.1.1's basis):
  - Emscripten [Networking](https://emscripten.org/docs/porting/networking.html) (*"direct access to TCP
    sockets is not possible from web browsers"*; the [official port list](https://github.com/emscripten-core/emscripten/tree/main/tools/ports) has no curl)
  - TypePHP (a same-shaped AOT compiler that has solved the same problem):
    [README-CN.md](https://github.com/swoole/typephp/blob/master/README-CN.md) (`link-libs: curl` /
    `ext-deps: curl` / Nano with no network), [WASI_BUILD.md](https://github.com/swoole/typephp/blob/master/docs/zh-cn/WASI_BUILD.md)
    (OpenSSL crypto-only, the `wasi:http` Component, Facade disabled entirely)
- Related within the project: [`as3-semantics.md`](as3-semantics.md) §3 (where async IO executes and when it is
  drained), `examples/async-io.as` (the existing async job contract regression), `examples/stage62.as` /
  `examples/stage63.as`