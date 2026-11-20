# Release packaging: `.app` / DMG / Windows `.exe`

> Implemented in stages 306–308. These forms reuse the same readable C, link rules, ANE host
> library and dependency directories. `xcode-project` remains the IDE/debugging escape hatch;
> it is no longer the release entry point.

## Final artifacts

| Command | Host / target | Result |
|---|---|---|
| `as-aot --air-app app.xml --package app` | macOS / native | `<Product>.app`, ad-hoc signed |
| `as-aot --air-app app.xml --package dmg` | macOS / native | Developer ID signed, notarized and stapled `.app` + `.dmg` |
| `as-aot --air-app app.xml --cc clang --package exe` | Windows / native | `<Product>.exe` with icon, VERSIONINFO and application manifest; optional Authenticode |

```bash
node src/index.ts --air-app app.xml --package app -o build/MyApp
node src/index.ts --air-app app.xml --package dmg -o build/MyApp
node src/index.ts --air-app app.xml --cc clang --package exe -o build/MyApp  # Windows host
```

The existing `raw`, `xcode-project` and `web` behavior is unchanged. No Electron, bundled Node
or consumer-side as3compiler installation is required. `--dry` prints the complete command chain
without producing a release or contacting Apple. External tools receive argv arrays, not shell strings.

## Metadata and manifest fields

`--air-app` now maps `<id>`, `<name>` (fallback `<filename>`), `<versionNumber>`,
`<versionLabel>`, `<copyright>` (VERSIONINFO `LegalCopyright`), `<publisher>` (VERSIONINFO
`CompanyName`) and `<icon><imageNNxNN>` into release metadata. Precedence is
**environment (signing overrides only) → explicit build manifest → AIR descriptor → defaults**.
With `--air-app app.xml --manifest release.json`, the explicit manifest is a **release overlay**
applied after the generated one, so signing and entitlements survive `<filename>.build.json`
regeneration. Relative paths resolve from the manifest that declares them. Changing the normal
product name or version therefore only requires editing `app.xml`.

New/extended manifest keys are `air-icons`, `version`, `build-version`, `company-name`,
`legal-copyright`, `windows-subsystem`, `signing-identity`, `notary-profile`, `entitlements` and
`timestamp-server`.
Relative paths resolve from the manifest. `company-name`/`legal-copyright` only reach the resource
when the descriptor or manifest actually supplies them: the default stays an empty company, never a
fabricated vendor.
`--doctor` checks the applicable platform tools, Developer ID private key, offline keychain profile,
`llvm-rc` and `signtool`; only an actual DMG build contacts Apple's notary service.

## macOS app bundle

The bundle has the standard `Contents/{Info.plist,PkgInfo,MacOS,Resources}` layout. Descriptor PNGs
are converted through an iconset and `iconutil`; each declared image must be a real PNG of its declared
size. The executable is linked directly at its final `Contents/MacOS/` path so executable-relative
assets and ANEs retain their existing layout.

Dotted ANE directories are nested code bundles to `codesign`. Packaging gives each ANE a minimal
`BNDL` Info.plist, signs every ANE and then the outer app; it never uses `codesign --deep`.
`--package app` uses ad-hoc signing for development/internal runs, not public Gatekeeper distribution.

## Developer ID, notarization and DMG

Store an app-specific password once in Keychain (never in the manifest, scripts, logs or Git):

```bash
xcrun notarytool store-credentials "my-notary" \
  --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
```

```json
{
  "package": "dmg",
  "signing-identity": "Developer ID Application: Example Ltd. (TEAMID)",
  "notary-profile": "my-notary",
  "entitlements": "entitlements.plist"
}
```

`ASC_SIGN_IDENTITY` and `ASC_NOTARY_PROFILE` override the manifest. Missing credentials fail before
signing. Packaging signs nested native images deepest-first, then the main executable and app, with
Hardened Runtime, secure timestamps and optional entitlements. It verifies signatures, submits a ZIP
with `notarytool submit --wait`, requires `Accepted`, staples the app, creates a UDZO DMG containing
the app and `/Applications`, then signs/notarizes/staples the DMG and runs `spctl` and `stapler validate`.
Timeouts and rejected submissions abort the release.

## Windows resources and Authenticode

`llvm-rc` compiles the generated RC into a `.res` consumed by the existing clang/MSVC ABI link. The
whole path has been measured on Windows against a real application (stage 448): the resource-bearing
exe starts, closes cleanly, and its properties page shows version, product name, company and
copyright.

Resources include a PNG-compressed multi-size ICO, VERSIONINFO (four numeric fields plus original
version text, `ProductName`/`FileDescription` from the display name, `CompanyName` from
`<publisher>`, `LegalCopyright` from `<copyright>`, `InternalName` from `<id>`), Windows 10
compatibility, `longPathAware`, and PerMonitorV2 with V1 DPI fallback. Windows 10 is the minimum
declared version.

The RC source is written as UTF-8. As soon as it carries a non-ASCII character (a Chinese company
name, or the invisible directional mark some descriptors put inside `<copyright>`), the resource
command gains the input codepage `/C 65001` (`/c 65001` for `rc.exe`): llvm-rc rejects such a file
under its default codepage (`Non-ASCII 8-bit codepoint ... can't be interpreted in the current
codepage`), and `rc.exe` would read the bytes as ANSI and store mojibake. Pure-ASCII scripts keep
the bare command line they always had.

### Subsystem: a release build must not open a console

The resources and the version strings live inside the exe, but the extra black window on
double-click is a different PE header field: the subsystem. Every native Windows exe used to be
`IMAGE_SUBSYSTEM_WINDOWS_CUI` (0x3), so a packaged app launched from Explorer was handed a console
window that carried the runtime's traces plus whatever the ANEs' SDKs print to stdout (Zoom's
`cmd debug:` lines, the segment AI SDK's GLFW banner). `adl.exe` is a CUI program; an installed AIR
application is not — and only `/SUBSYSTEM` can express that difference.

The choice is now inferred from the artifact: `package: "exe"` and `--air-app` builds get
`IMAGE_SUBSYSTEM_WINDOWS_GUI` (0x2), everything else stays `console`. A manifest may override it in
either direction with `windows-subsystem`. The `windows` value adds `/SUBSYSTEM:WINDOWS` **and**
`/ENTRY:mainCRTStartup` — the entry flag is required, because the generated C defines
`int main(void)` while a GUI subsystem defaults to `WinMainCRTStartup`, and shipping the subsystem
flag alone fails to link. Arguments, exit codes and inherited stdout handles are unchanged (a GUI
exe started from cmd still inherits the console's handles, which is why `ASC_GL_TRACE=1` stderr
diagnostics keep working).

Measured on a real application (stage 449): the same app and resources moved from
`Subsystem: IMAGE_SUBSYSTEM_WINDOWS_CUI (0x3)` to `WINDOWS_GUI (0x2)`; enumerating visible
top-level windows after launching it the way Explorer does reported **zero** `ConsoleWindowClass`
windows, leaving only the app's own `SDL_app` window, and the process closed with exit code 0. The
32-bit `/LARGEADDRESSAWARE` bit (0x0020) is still set.

An unsigned exe remains buildable but emits an explicit SmartScreen warning. To sign:

```json
{
  "package": "exe",
  "signing-identity": "<certificate thumbprint or subject>",
  "timestamp-server": "http://timestamp.digicert.com"
}
```

Environment overrides: `ASC_SIGN_IDENTITY`, `ASC_WIN_CERT_FILE`, `ASC_WIN_CERT_PASSWORD` and
`ASC_WIN_TIMESTAMP`. `signtool sign /fd SHA256` selects `/n`, `/sha1`, `/f` and `/p` as applicable,
then `signtool verify /pa` runs. Passwords are replaced with `<redacted>` in logs.

macOS CI builds/runs/verifies an ad-hoc `.app`; Windows CI builds/runs a resource-bearing unsigned exe
without publishing secrets. Stage 448 adds real-machine evidence for the Windows resources and
VERSIONINFO (including `CompanyName`/`LegalCopyright` and the UTF-8 codepage path for non-ASCII
publisher names); Authenticode itself has still not run here (no certificate).
App Store, MSI/MSIX, universal2, auto-update and decorative DMG layouts are out of scope.
