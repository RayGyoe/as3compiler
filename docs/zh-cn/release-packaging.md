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
| `<icon><imageNNxNN>` | 各尺寸 PNG，macOS 生成 `.icns`，Windows 生成 PNG-compressed ICO |

有效优先级是 **环境变量（仅签名凭据）→ 显式构建清单 → AIR 描述符 → 默认值**。
同时给出 `--air-app app.xml --manifest release.json` 时，后者是**发布覆盖层**，在生成清单之后
合并；因此签名与 entitlements 不会被 `<filename>.build.json` 的重新生成覆盖。相对路径按各自
清单所在目录解析。日常改名、改版本只编辑 `app.xml`。

新增/扩展的构建清单字段：`air-icons`、`version`、`build-version`、`signing-identity`、
`notary-profile`、`entitlements`、`timestamp-server`。路径均相对清单目录。缺省 bundle id 仍是
`com.example.<product>`，Windows 最低版本为 10.0。

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
`NSHighResolutionCapable=true` 和 `LSMinimumSystemVersion`。描述符图标经 iconset + `iconutil`
转换；每个声明尺寸都必须是真实 PNG 且尺寸相符，不会拿别的尺寸静默顶替。

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
clang/MSVC ABI 链接命令；生成侧逻辑已单测，但真实 PE 运行与签名必须在 Windows 验证。

资源包括：

- 描述符多尺寸 PNG 合成的 PNG-compressed ICO（含 256×256）；
- `VERSIONINFO`：合法化后的四段 `FileVersion`/`ProductVersion`，原始版本文案；
- 显式启用的 `longPathAware`、Windows 10 兼容性 GUID；
- `PerMonitorV2` DPI awareness + PerMonitorV1 回退，避免 Windows 10 位图拉伸。

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
公证仍在持有凭据的发布机上验证。

非目标：App Store、MSI/MSIX、universal2、自动更新和装饰性 DMG 布局。
