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
`<versionLabel>`, `<copyright>` (Windows VERSIONINFO `LegalCopyright` **and** macOS
`NSHumanReadableCopyright`), `<publisher>` (Windows VERSIONINFO `CompanyName`; macOS has no
matching visible field, so nothing is written there) and `<icon><imageNNxNN>` into release
metadata. Precedence is
**environment (signing overrides only) → explicit build manifest → AIR descriptor → defaults**.
With `--air-app app.xml --manifest release.json`, the explicit manifest is a **release overlay**
applied after the generated one, so signing and entitlements survive `<filename>.build.json`
regeneration. Relative paths resolve from the manifest that declares them. Changing the normal
product name or version therefore only requires editing `app.xml`.

New/extended manifest keys are `air-icons`, `version`, `build-version`, `company-name`,
`legal-copyright`, `windows-subsystem`, `signing-identity`, `notary-profile`, `entitlements` and
`timestamp-server`.
Relative paths resolve from the manifest. `company-name`/`legal-copyright` only reach the artifact
when the descriptor or manifest actually supplies them: the default stays an empty company, never a
fabricated vendor. **`legal-copyright` is a two-platform field** (stage 456): VERSIONINFO on Windows,
`NSHumanReadableCopyright` on macOS. With no copyright declared the **whole key is absent** rather
than present-and-blank. `company-name` stays Windows-only: Finder's Get Info and the About panel show
name, version and copyright, and macOS has no "company" slot to invent a key for.
`--doctor` checks the applicable platform tools, Developer ID private key, offline keychain profile,
`llvm-rc` and `signtool`; only an actual DMG build contacts Apple's notary service.

## macOS app bundle

The bundle has the standard `Contents/{Info.plist,PkgInfo,MacOS,Resources}` layout. Descriptor PNGs
are converted through an iconset and `iconutil`; each declared image must be a real PNG of its declared
size. The executable is linked directly at its final `Contents/MacOS/` path so executable-relative
assets and ANEs retain their existing layout.

`Info.plist` carries `CFBundleExecutable`, `CFBundleIdentifier`, `CFBundleName`, both version fields,
`NSHighResolutionCapable=true` and `LSMinimumSystemVersion`, plus `NSHumanReadableCopyright` when the
descriptor declares `<copyright>` (stage 456).

**Copyright on both macOS paths** (stage 456): `--package app`/`dmg` and `--package xcode-project`
write the same `Info.plist` semantics, so they share the one XML escaper exported from
`app-bundle.ts` — an unescaped `&`, `<` or quote in a real copyright line is a **malformed plist**, not
a cosmetic defect. Unlike `llvm-rc` on Windows, a plist is UTF-8 XML: a Chinese copyright, or the
invisible U+200E a real descriptor carried, needs **no code page step** and travels verbatim (the
Windows `/C 65001` step is in the Windows section below). A nested ANE's `BNDL` plist does **not**
inherit the app's copyright.

Measured (macOS arm64, `--air-app` descriptor with a Chinese `<copyright>`):
`PlistBuddy -c "Print :NSHumanReadableCopyright"` reads the same string back from both the `.app` and
the `.xcodeproj` plist (U+200E included), `plutil -lint` reports OK for both, and the ad-hoc
`codesign --verify` passes. `--package dmg` goes through the same `createMacApp`, so the copyright
also reaches the plist that gets notarized.

**Boundary**: an existing `.xcodeproj` takes the smart-merge path (refresh the source list only, keep
the developer's hand edits) and does **not** rewrite `Info.plist`. Adding `<copyright>` to an old
project requires deleting and regenerating it — the same existing behaviour as `<name>`, icons and
versions on that path, not a limitation specific to the copyright field.

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

### trace: release artifacts carry none (two gates)

Once the console window is gone, `trace()` has nowhere to go in a release build — but that does not
mean it is absent: the default `printf` + `fflush(stdout)` still formats and still issues a write
that is bound to fail. Release artifacts therefore gate trace in two layers (stage 450):

1. **Compile time**: `package` `exe`/`app`/`dmg` emits `#define ASC_TRACE 0`, so neither the
   `printf` nor its format strings reach the binary. **Arguments are still evaluated** —
   `trace(++i)` still increments `i`, and only pure expressions are eliminated by `-O2`. Dropping
   the statement outright would change program semantics, which is not an optimisation.
2. **Runtime**: builds that do carry trace (`--run`, `--package raw`) wrap it in `as_trace_on()`, so
   `ASC_TRACE=0` in the environment silences output without a rebuild — the layer Qt
   (`QT_LOGGING_RULES`), glog (`GLOG_v`) and Rust (`RUST_LOG`) all provide. Only the literal `0`
   disables it; any other value keeps output on.

The manifest field `trace: "on" | "off"` overrides the inference in either direction. Measured on a
real application: the release build's generated C went from **1020 to 335** `printf(` sites (the
rest are the runtime's own OOM/GC diagnostics), and the exe started, rendered and closed normally.

Third-party SDKs (Zoom, the segment AI SDK, …) printing to stdout are outside this mechanism — they
belong to their own extensions, and the only thing that silences them is having no console to write
to.

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
