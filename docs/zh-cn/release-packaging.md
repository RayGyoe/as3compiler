# 发布打包：`.app` / DMG / Windows `.exe`

> 实现于阶段三百零六～三百零八。沿用同一份可读 C、链接规则、ANE 宿主库和依赖目录；
> 打包只改变编译产物的组织方式。`xcode-project` 继续保留给 IDE 断点调试，不再兼任发布入口。

## 1. 三种最终产物

| 命令 | 宿主/目标 | 产物与签名 |
|---|---|---|
| `as-aot --air-app app.xml --package app` | macOS / native | `<Product>.app`；ad-hoc 签名 |
| `as-aot --air-app app.xml --package dmg` | macOS / native | Developer ID、Hardened Runtime、公证并 staple 的 `.app` + `.dmg` |
| `as-aot --air-app app.xml --cc clang --package exe` | Windows / native | 带图标、版本和 application manifest 的 `<Product>.exe`；可配 Authenticode |

`--package raw`、既有 `xcode-project` 和 `web` 行为不变。`.app`、DMG、`.exe` 都不需要
Electron、Node 随包或用户机安装 as3compiler。macOS 的两种脚本包必须在 macOS 上构建；
Windows `exe` 必须在 Windows 上构建，不支持从其他宿主静默降级。

```bash
# 开发机：可直接双击/打开
node src/index.ts --air-app app.xml --package app -o build/MyApp

# macOS 发布
node src/index.ts --air-app app.xml --package dmg -o build/MyApp

# Windows 发布（Windows 主机）
node src/index.ts --air-app app.xml --cc clang --package exe -o build/MyApp
```

`--dry` 会展开编译、资源与签名/公证命令，不创建发布产物、不调用 Apple。所有外部工具都按
argv 执行，不拼 shell 命令；路径中的空格无需另写转义。

## 2. AIR 描述符是唯一日常元数据源

`--air-app` 现在把以下字段接入发布清单：

| `app.xml` | 用途 |
|---|---|
| `<id>` | macOS `CFBundleIdentifier` |
| `<name>` | 显示名，回退 `<filename>` |
| `<versionNumber>` | `CFBundleShortVersionString` / Windows VERSIONINFO |
| `<versionLabel>` | `CFBundleVersion`，缺省 `0` |
| `<copyright>` | Windows VERSIONINFO `LegalCopyright`；macOS `Info.plist` 的 `NSHumanReadableCopyright` |
| `<publisher>` | Windows VERSIONINFO `CompanyName`（macOS 无对应的可见字段，不写） |
| `<icon><imageNNxNN>` | 各尺寸 PNG，macOS 生成 `.icns`，Windows 生成 PNG-compressed ICO |

有效优先级是 **环境变量（仅签名凭据）→ 显式构建清单 → AIR 描述符 → 默认值**。
同时给出 `--air-app app.xml --manifest release.json` 时，后者是**发布覆盖层**，在生成清单之后
合并；因此签名与 entitlements 不会被 `<filename>.build.json` 的重新生成覆盖。相对路径按各自
清单所在目录解析。日常改名、改版本只编辑 `app.xml`。

新增/扩展的构建清单字段：`air-icons`、`version`、`build-version`、`company-name`、
`legal-copyright`、`windows-subsystem`、`signing-identity`、`notary-profile`、`entitlements`、
`timestamp-server`。
路径均相对清单目录。缺省 bundle id 仍是 `com.example.<product>`，Windows 最低版本为 10.0。
`company-name`/`legal-copyright` 只在描述符或清单真的给出时才落进产物；缺省仍是公司名为空串，
不臆造厂商。**`legal-copyright` 是双端字段**（阶段四百五十六）：Windows 进 VERSIONINFO，
macOS 进 `NSHumanReadableCopyright`——描述符没写时**整个键不出现**，而不是留一个空版权。
`company-name` 仍是 Windows 独有：Finder 简介与关于面板只显示名称、版本、版权，macOS 没有
「公司」这一栏，故不臆造一个键去放它。

`--doctor` 在相应发布形态下检查系统签名工具、Developer ID 私钥、离线 keychain profile 查询、
`llvm-rc` 与 `signtool`。真实公证只在 `--package dmg` 时发起网络请求。

## 3. macOS `.app`

标准布局：

```text
MyApp.app/
  Contents/
    Info.plist
    PkgInfo
    MacOS/MyApp
    Resources/MyApp.icns     # 描述符声明图标时
```

`Info.plist` 含 `CFBundleExecutable`、`CFBundleIdentifier`、`CFBundleName`、两个版本字段、
`NSHighResolutionCapable=true` 和 `LSMinimumSystemVersion`；描述符给了 `<copyright>` 时再加
`NSHumanReadableCopyright`（阶段四百五十六）。描述符图标经 iconset + `iconutil`
转换；每个声明尺寸都必须是真实 PNG 且尺寸相符，不会拿别的尺寸静默顶替。

**版权在 macOS 的两条路径**（阶段四百五十六）：`--package app`/`dmg` 与 `--package xcode-project`
写的是同一份 `Info.plist` 语义，故共用 `app-bundle.ts` 导出的同一个 XML 转义器——真实版权行里的
`&`、`<`、引号若不转义就是**坏 plist**，不是外观问题。与 Windows 的 `llvm-rc` 不同，plist 是
UTF-8 XML：中文版权、乃至真描述符里夹的不可见 U+200E **无需代码页处理**，逐字带出即可
（Windows 侧那一步 `/C 65001` 见 §5）。嵌套 ANE 的 `BNDL` plist **不继承** app 的版权。

实测（macOS arm64，`--air-app` 描述符带中文 `<copyright>`）：`PlistBuddy -c "Print
:NSHumanReadableCopyright"` 从 `.app` 与 `.xcodeproj` 两份 plist 读回同一串（含 U+200E），
`plutil -lint` 均 OK，ad-hoc 签名 `codesign --verify` 通过。`--package dmg` 走同一个
`createMacApp`，故版权同样进公证前的那份 plist。

**边界**：已存在的 `.xcodeproj` 走 smart-merge（只刷源文件清单、保留开发者手改），
**不重写 `Info.plist`**。给旧工程新添 `<copyright>` 需删掉工程重建——这与 `<name>`/图标/版本
在该路径上的既有行为一致，不是版权字段特有的限制。

链接产物直接落在最终 `Contents/MacOS/` 路径，因此既有的可执行文件相对资源与 ANE 布局不需搬迁。
带点号的 ANE 目录会被 `codesign` 识别为嵌套 bundle：打包器为其补最小 `BNDL` 类型
`Info.plist`，并逐个签名 ANE、再签外层 `.app`。**不使用 `codesign --deep`**。

`--package app` 只用于开发与内部分发：ad-hoc 不等于 Developer ID，也不通过 Gatekeeper 发布验收。

## 4. Developer ID、公证与 DMG

一次性把 Apple 专用 App 密码存进钥匙串（密码不要写入清单、命令脚本、日志或 Git）：

```bash
xcrun notarytool store-credentials "my-notary" \
  --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
```

示例配置：

```json
{
  "package": "dmg",
  "signing-identity": "Developer ID Application: Example Ltd. (TEAMID)",
  "notary-profile": "my-notary",
  "entitlements": "entitlements.plist"
}
```

环境变量 `ASC_SIGN_IDENTITY`、`ASC_NOTARY_PROFILE` 优先于清单。缺证书或 profile 会在执行签名前
响亮失败；不会输出「看似发布版、实际未签名/未公证」的 DMG。

执行顺序：

1. 最深层优先签名 dylib、framework、ANE bundle 及其中原生库，再签主可执行文件和外层 `.app`；
2. 所有签名使用 Hardened Runtime + secure timestamp，可选 entitlements；严格 `codesign --verify`；
3. ZIP 提交 `notarytool submit --wait`，仅接受 `status: Accepted`，随后 staple `.app`；
4. staging 中放 `.app` 和 `/Applications` 符号链接，`hdiutil` 生成压缩 UDZO DMG；
5. DMG 再签名、公证、staple；最终执行 `spctl -a -t open` 与 `stapler validate`。

命令日志只显示 keychain profile 名，不显示凭据。公证超时、拒绝或其他非 Accepted 状态都会
中止，不继续生成可发布镜像。

## 5. Windows 图标、版本、manifest 与签名

`--package exe` 使用原生 `llvm-rc`（或 `rc.exe`）把资源编译成 `.res`，再交给既有
clang/MSVC ABI 链接命令。整条链路已在 Windows 真机上对真实应用跑通（阶段四百四十八）：
资源 exe 能启动、能干净关闭，文件属性页显示版本、产品名、公司与版权；未签名的 exe
仍会明确告警。

资源包括：

- 描述符多尺寸 PNG 合成的 PNG-compressed ICO（含 256×256）；
- `VERSIONINFO`：合法化后的四段 `FileVersion`/`ProductVersion`，原始版本文案，以及
  `ProductName`/`FileDescription`（显示名，缺省 `<filename>`）、`CompanyName`（`<publisher>`）、
  `LegalCopyright`（`<copyright>`）、`InternalName`（`<id>`）；
- 显式启用的 `longPathAware`、Windows 10 兼容性 GUID；
- `PerMonitorV2` DPI awareness + PerMonitorV1 回退，避免 Windows 10 位图拉伸。

RC 源文件按 UTF-8 写盘。脚本里一旦出现非 ASCII 字符（中文公司名，或 `<copyright>` 里
夹带的不可见方向标记），资源命令会自动追加输入代码页 `/C 65001`（`rc.exe` 形态为
`/c 65001`）：llvm-rc 在默认代码页下会直接拒绝这类文件
（`Non-ASCII 8-bit codepoint ... can't be interpreted in the current codepage`），
而 rc.exe 会按 ANSI 代码页读成乱码。纯 ASCII 脚本保持原有命令行不变。

### 子系统：发布版不应带控制台窗

资源与版本号都在 exe 里，但“双击后多出一个黑窗”是**另一个** PE 头字段：子系统。以前每条
原生 Windows exe 都是 `IMAGE_SUBSYSTEM_WINDOWS_CUI`（0x3），于是发布版从资源管理器双击
启动时 Windows 会分配一个控制台窗口，里面滚动的是运行时 trace 与各个 ANE 的 SDK 自己往
stdout 写的东西（Zoom 的 `cmd debug:` 行、分段 AI SDK 的 GLFW 横幅）。`adl.exe` 是 CUI
程序，装好的 AIR 应用不是——差异只能用 `/SUBSYSTEM` 表达。

现在按产物推断：`package: "exe"` 与 `--air-app` 构建得到 `IMAGE_SUBSYSTEM_WINDOWS_GUI`（0x2），
其余仍是 `console`。清单可用 `windows-subsystem` 显式覆盖两个方向。`windows` 会同时加
`/SUBSYSTEM:WINDOWS` 与 `/ENTRY:mainCRTStartup`——后者是必须的：我们的生成 C 是
`int main(void)`，而 GUI 子系统的默认入口叫 `WinMainCRTStartup`，只给子系统不给入口会
链接失败。参数、退出码与继承的 stdout 句柄都不变（GUI 程序从 cmd 启动时仍继承控制台
句柄，所以 `ASC_GL_TRACE=1` 的 stderr 诊断照常可见）。

真机实测（阶段四百四十九）：同一份应用、同一套资源，PE 头从
`Subsystem: IMAGE_SUBSYSTEM_WINDOWS_CUI (0x3)` 变为 `WINDOWS_GUI (0x2)`；从资源管理器
方式启动后枚举可见顶层窗口，`ConsoleWindowClass` 计数为 **0**，应用只剩自己的
`SDL_app` 窗口；关闭后进程 exit code 0。32 位镜像的 `/LARGEADDRESSAWARE` 位（0x0020）
仍保留。

### trace：发布产物不带 trace（两层闸门）

黑窗没了之后，`trace()` 在发布版里也**无处可去**——但这不等于它不存在：默认发射的
`printf` + `fflush(stdout)` 仍然会格式化、仍然会调一次必然失败的写。所以发布产物的
trace 由两层闸门控制（阶段四百五十）：

1. **编译期**：`package` 为 `exe`/`app`/`dmg` 时发射 `#define ASC_TRACE 0`，`printf` 与
   它的格式串根本不进二进制。**参数照旧求值**——`trace(++i)` 仍然会让 `i` 自增，只有
   纯表达式会被 `-O2` 删干净；删掉整条语句就是改程序语义，不属优化范畴。
2. **运行期**：编译期开着 trace 的构建（普通 `--run`、`--package raw`）额外包一层
   `as_trace_on()`；环境变量 `ASC_TRACE=0` 可在不重编的前提下静默输出（Qt 的
   `QT_LOGGING_RULES`、glog 的 `GLOG_v`、Rust 的 `RUST_LOG` 都是这一层）。只有字面量
   `0` 关闭，其他值一律保持输出。

清单字段 `trace: "on" | "off"` 覆盖上述推断，两个方向都可以。真应用实测：发布版生成的 C
从 `printf(` **1020 处降到 335 处**（剩下的都是运行时的 OOM/GC 诊断），exe 启动、渲染、
关闭均正常。

第三方 SDK（Zoom、分段 AI 等）自己往 stdout 写的日志不在此机制范围内——它们属于各自的
扩展库，只能靠“没有控制台可写”来消除。

清单无签名配置时 exe 仍可构建运行，但会明确警告未签名、可能触发 SmartScreen。
要签名时配置：

```json
{
  "package": "exe",
  "signing-identity": "<certificate thumbprint or subject>",
  "timestamp-server": "http://timestamp.digicert.com"
}
```

也支持环境变量 `ASC_SIGN_IDENTITY`、`ASC_WIN_CERT_FILE`、`ASC_WIN_CERT_PASSWORD`、
`ASC_WIN_TIMESTAMP`。调用 `signtool sign /fd SHA256`，自动识别 `/n`、`/sha1`、`/f`、`/p`，
随后 `signtool verify /pa`。日志对密码逐字替换为 `<redacted>`。证书与密码不进 Git。

## 6. CI 与边界

macOS CI 增加 `.app` 构建、运行与 ad-hoc `codesign --verify` 冒烟；Windows CI 增加真实
`llvm-rc` 资源链接、exe 运行与未签名告警冒烟。CI 不需要发布密钥。真实 Authenticode 与 Apple
公证仍在持有凭据的发布机上验证——Windows 侧的资源与 VERSIONINFO 已由阶段四百四十八的真机
构建补上证据（含 `CompanyName`/`LegalCopyright` 与中文公司名的 UTF-8 代码页处理），
Authenticode 本机仍未执行（无证书）。

非目标：App Store、MSI/MSIX、universal2、自动更新和装饰性 DMG 布局。
