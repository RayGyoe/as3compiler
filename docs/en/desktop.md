# Desktop integration (`flash.desktop` icon family + `flash.display.NativeMenu`) — measured behaviour

> This document records the **measured semantics** and implementation choices for
> **`Icon` / `InteractiveIcon` / `DockIcon` / `SystemTrayIcon`**, **`NativeApplication.icon` / `menu` /
> `autoExit` / the five capability flags**, and **`flash.display.NativeMenu` / `NativeMenuItem`**
> (stage 255, v0.4.218 → v0.4.219). It is the **G4a** capability of the macOS cleaner demo
> (`prune/mac-cleaner-demo-plan.md` in the workspace root, outside this repository).
>
> **Source of truth**: `adl 51.4.1` (macOS 26) probes in `temp/deskprobe2/` (`Probe*.as` compiled with
> `mxmlc`, run with `adl`, logging to files — `adl` prints nothing to stdout). Every "AIR does X" claim
> below has a matching probe transcript; none is transcribed from documentation.
>
> One-line summary: **AIR has a first-class icon API in `flash.desktop`** (it is *not* "no equivalent").
> On macOS `supportsDockIcon` is `true` and `supportsSystemTrayIcon` is `false`; `NativeApplication.menu`
> is **not** `null` and can be replaced wholesale.

---

## 1. Coverage

| Member | Status | Notes |
|---|---|---|
| `Icon` | ✅ | **instantiable** (`new Icon()` is legal); `bitmaps` defaults to `null` (reading it throws `#1009`) |
| `InteractiveIcon` | ✅ model | `new InteractiveIcon()` throws `#2012`; `width`/`height` are derived read-only |
| `DockIcon` | ✅ (incl. Dock context menu) | `new DockIcon()` throws `#2012`; **bitmaps are not painted** (§7.2) |
| `SystemTrayIcon` | ✅ model | AIR itself refuses it on macOS (`#2012`), and so do we |
| `NativeApplication.icon` | ✅ | **read-only** (`mxmlc`: "property icon is read-only"); process-wide singleton |
| `NativeApplication.menu` | ✅ | readable and writable; `= null` **crashes** `adl` — we report and keep the old menu (§7.1) |
| `NativeApplication.autoExit` | ✅ | real: with `false` and no visible window the process stays alive |
| `supportsDockIcon` / `supportsMenu` | ✅ | `true` only under `ASC_USE_WINDOW && __APPLE__` (§2) |
| `supportsSystemTrayIcon` / `supportsStartAtLogin` / `supportsDefaultApplication` | ✅ always `false` | matches what this backend actually implements (§2) |
| `NativeMenu` / `NativeMenuItem` | ✅ all members | list semantics, error codes and copy semantics match `adl` (§4, §5) |
| `NativeMenu.display()` | ⚠️ reported | no modal native menu runner in this backend (§7.3) |
| `keyEquivalentModifiers` | ⚠️ reported | the key is bound, the modifier flags are **not** translated (§7.2) |

---

## 2. Capability flags (the five static properties)

| Property | `adl 51.4.1` / macOS | Ours | Why |
|---|---|---|---|
| `supportsDockIcon` | **`true`** | `ASC_HAS_DOCK` | `1` only for `ASC_USE_WINDOW && __APPLE__` |
| `supportsMenu` | **`true`** | `ASC_HAS_APP_MENU` | same |
| `supportsSystemTrayIcon` | **`false`** | `0` | macOS has no tray; AIR does not claim one either |
| `supportsStartAtLogin` | **`true`** | **`0`** | **deliberate divergence**: no login-item backend |
| `supportsDefaultApplication` | **`true`** | **`0`** | **deliberate divergence**: no default-app registration |

Why the last two report **less** than AIR: these flags describe what the **backend** can do, not what AS3
syntax exists. Reporting `true` would let `if (NativeApplication.supportsStartAtLogin) { … }` enter a branch
that silently does nothing — exactly the silent degradation AGENTS §1.5 forbids. Reporting `false` makes the
same guard skip, so the caller learns the path is unavailable. The `startAtLogin` **getter** still throws
`#2014` (`IllegalOperationError`) exactly like `adl`.

> Without a window backend (pure C / wasm) both `ASC_HAS_DOCK` and `ASC_HAS_APP_MENU` are `0`, yet
> `NativeApplication.icon` still returns a complete `DockIcon` model object — **the model always works, the
> capability flags answer whether it can reach the screen**. The two are kept separate.

---

## 3. The icon family

| Case | `adl 51.4.1` | Ours |
|---|---|---|
| `new Icon()` | legal | same |
| `new InteractiveIcon()` / `new DockIcon()` / `new SystemTrayIcon()` | `Error #2012: X$ class cannot be instantiated.` | same code and wording |
| `new Icon().bitmaps` | `#1009` (defaults to `null`) | same |
| `icon === NativeApplication.nativeApplication.icon` | same instance | same (process singleton) |
| `dockIcon.bitmaps = [b1, b2]` | `width`/`height` = per-axis **max** | same |
| `bitmaps = []` | width/height **keep their last value** | same |
| `bitmaps = [1]` | `#2005: Parameter 0 is of the incorrect type. Should be type BitmapData.` | same |
| `bitmaps = null` | `#2007: Parameter bitmaps must be non-null.` | same |
| `bitmaps` getter | **fresh `Array` each read** | same |
| `bounce(null)` | `#2007: Parameter value must be non-null.` | same |
| `bounce("bogus")` | **no throw** (unknown priority treated as informational) | same (`NSCriticalRequest` / `NSInformationalRequest`) |
| `dockIcon.menu = "string"` | reads back `null` | same |
| `SystemTrayIcon.MAX_TIP_LENGTH` | `63` | same |

---

## 4. `NativeMenuItem`

Defaults measured on `new NativeMenuItem("Hello")`:

```
label="Hello"  name=null  enabled=true  checked=false  isSeparator=false
keyEquivalent=null  keyEquivalentModifiers=[15]  mnemonicIndex=-1  data=null
```

- **`toString()` is reproduced verbatim**:
  `[NativeMenuItem label="Hello" keyEquivalent=null keyEquivalentChar=0 keyEquivalentModifiers={ 15 }]`
- **`keyEquivalentModifiers` keeps only `15..20`**, ascending and de-duplicated
  (`[18,16,16,3,99]` → `[16,18]`); the getter returns a **fresh `Array`**; a non-`Array` throws `#1034`.
- `keyEquivalent = ""` reads back as **`null`**.
- `clone()` **does not copy `data`** (measured); `submenu` is deep-copied.
- There is **no** `NativeMenuItemSeparator` class — it does not exist in AIR (it is Flex's `mx` class);
  use the ctor's second argument: `new NativeMenuItem("", true)`.

---

## 5. `NativeMenu`

**`isSupported` is static** (`NativeMenu.isSupported` → `true`); reading it **on an instance throws `#1069`**.

| Case | `adl 51.4.1` | Ours |
|---|---|---|
| `addItem(existing)` | **silent no-op** | same |
| `addItemAt(existing)` | `#2004` | same |
| `addItem(null)` / `getItemByName(null)` | `#2007` (`Parameter item` / `Parameter name`) | same |
| `removeItem(foreign item)` | `#2006: The supplied index is out of bounds.` | same |
| `addItemAt(99)` / `addItemAt(-1)` / `getItemAt(-1)` / `getItemAt(99)` | `#2006` | same |
| `addItemAt(numItems)` | appends | same |
| `getItemByName` | matches **`name`** only, never `label` | same |
| `items` getter | **fresh `Array` each read** | same |
| `items = null` | `#1009`; `items = [1]` → `#1034` | same |
| `setItemIndex(foreign item)` | silent no-op | same |
| `addSubmenu(sub, label)` | `sub.parent` becomes that menu | same |
| `addItem(item)` where `item.submenu` is already set | **`submenu.parent` becomes that menu** (`probe7.txt`) | same (added this stage) |
| `removeItem(item)` | both `item.menu` and `item.submenu.parent` become `null` (`probe7.txt`) | same (added this stage) |
| the same item added to a second menu | `#2004` | same |
| `clone()` | deep-copies items, drops `data`, the clone's `submenu.parent` is `null` | same |

**Click dispatch (`probe4-log.txt`)**: a native click delivers `Event.SELECT` **to the `NativeMenuItem` and
to the owning `NativeMenu`**, with `bubbles=false`, `cancelable=false`, `data` intact.

---

## 6. Native wiring (macOS / Cocoa)

A menu crosses the glue boundary **only as a flattened description** (`sk_menu` / `sk_menu_item`); the glue
never learns a generated C type:

```
generated C (model)          glue (window_glue.cc)
NativeMenu/NativeMenuItem →  sk_menu[] + sk_menu_item[] (depth-first, submenus are indices)
click tag (1-based)       ←  SKMenuTarget.skFired: → as_menu_click_cb
```

Four hard constraints, all earned by measurement:

1. **Never call `+[NSApplication sharedApplication]` from generated code** — doing so before SDL's video
   init leaves the process alive with **zero windows**. Generated code only reads `extern id NSApp`; if it
   is not there yet the install is **queued** and applied by the first `sk_menu_flush()` from `sk_run_loop`.
2. **AppKit/SDL install their own main menu after launch** (on the first event pump, later than
   `sk_menu_flush`), so the loop runs `sk_menu_ensure()` every frame: if the current main-menu pointer is
   not ours, re-`setMainMenu:`; if the Dock-menu delegate changed, re-swizzle `applicationDockMenu:`.
   Both are pointer comparisons — nothing is rebuilt.
3. **`autoExit` is part of the shared loop condition**: `while (sk_any_open() || !g_auto_exit)`, idling at
   ~60 Hz (`SDL_Delay(16)`) when nothing is visible. That is AIR's `autoExit=false` semantics, and it is
   what keeps a Dock-icon-only / menu-bar-only app alive.
4. **A menu's own items must be contiguous** in the flattened array (`first..first+count`). The first
   implementation recursed inside the parent loop, so a submenu's items landed in the middle of the
   parent's range and **the second top-level menu vanished from the real menu bar** — the one structural
   bug this stage found with AX and then confirmed by reading the code.

---

## 7. Platform boundaries and residues (reported, not hidden)

### 7.1 `NativeApplication.menu = null` **crashes** `adl`

Measured on `adl 51.4.1`: assigning `null` kills the adl process. Per §1.5 we do not rewrite AIR-defined
behaviour, so this is **reported and leaves the menu unchanged**
(`as_shell_unsupported("flash.desktop.NativeApplication.menu = null …")`).

### 7.2 Two "model is right, pixels/flags are not there yet" gaps (each reported once)

- **`DockIcon.bitmaps` is not painted**: the model (list, `#2005`/`#2007`, derived width/height) is exact,
  but the bitmap never reaches the Dock tile. Code written against AIR runs; the observable effect is "the
  icon does not change". **Reported once** and registered in `TODO.md` (遗留待开发).
- **`keyEquivalentModifiers` is not translated to `NSEventModifierFlags`**: the `keyEquivalent` is bound but
  the six legal values (`15..20`) are **not mapped**, so the shortcut would fire with AppKit's default
  modifiers. **Reported once** — never a silently wrong shortcut. Registered in `TODO.md`.

### 7.3 `NativeMenu.display()` has no modal backend

`display(stage, x, y)` shows a **modal** native menu in AIR. This backend's loop is a non-blocking event
pump with no nestable modal runner ⇒ **reported** and returns `undefined` (it does not pretend to have
shown anything).

### 7.4 macOS renames the first top-level item (**platform behaviour, not a defect**)

`adl`'s menu bar reads `Apple, Alpha, Beta` (**no application-menu slot**), while an AOT app reads
`Apple, <AppName>, Prune` — AppKit treats `mainMenu` **item 0** as the application menu and **overwrites its
title with the app name**. Our model is not wrong (`na.menu.items[0].label` is still `First`); this is Cocoa's
rule, and `adl` avoids it only because it already owns that slot.

**Contract**: in an AOT app the **first top-level menu is the application menu** (as in any native Mac app).
To keep a label of your own there, treat it as the app menu (put `Quit` and friends in it) and start business
menus at item 1.

### 7.5 Windows / wasm

Outside `ASC_USE_WINDOW && __APPLE__` every capability flag is `0` and `sk_menu_*` degrade to `static inline`
stubs. A Windows `HWND` menu bar is a stage of its own; the browser has no native menu concept, so `0` is the
honest answer there.

---

## 8. Verification and evidence

| Item | Evidence |
|---|---|
| 66 model assertions (pure-C build, no window backend) | `examples/native-menu.as` → `native-menu: 66 checks passed` |
| 38 source-level pins on the generated C | `unit: emit/NativeMenu` in `test/unit/emit.ts` |
| Real menu bar and real click | `temp/G4App.app` (`NSPrincipalClass=NSApplication`): AX reads `Apple, G4App, Prune`; clicking `Prune → PruneTwo` really ran the AS3 `SELECT` listener (wrote `/tmp/g4click.txt` = `two`) |
| Dock context menu | `sk_menu_install_dock` swizzles `applicationDockMenu:` onto SDL's delegate (the actual right-click is not automated) |
| `autoExit=false` residency | same bundle: the process survives closing the window until `NativeApplication.exit()` |
| Main-menu shape comparison | `probe8.txt` (`adl`: `Apple, Alpha, Beta`) vs the same model in an AOT app (§7.4) |

---

## 9. Not done (out of scope for this stage)

- **G4b: the macOS menu-bar `NSStatusItem`** — an **enhancement** (AIR has no macOS equivalent:
  `supportsSystemTrayIcon` is `false`), so it must be opt-in and is **not implemented here**. The feasibility
  probe passed (`temp/statusprobe/statusprobe.mm`: SDL window + `NSStatusBar` + `NSMenu`, clicks dispatched
  through SDL's own Cocoa pump — no hand-written `NSEvent` pump needed). Its documented fallback is the pure
  AIR `DockIcon` shape (Dock icon + Dock context menu + `autoExit=false`).