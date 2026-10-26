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
> **Addendum (stage 256, v0.4.219 → v0.4.220)**: `DockIcon.bitmaps` now really **reaches the Dock**. The
> stage first measured *which* bitmap AIR paints (`temp/dockprobe/`: solid colours, sampled out of a screen
> grab) and then handed the pixels to `-[NSApplication setApplicationIconImage:]` — so §3.1 is a new
> **selection-rule** table, §7.2 keeps only the modifier gap, and §7.6 records one rendering difference we
> deliberately do **not** copy (AIR multiplies alpha twice on semi-transparent pixels).
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
| `DockIcon` | ✅ (incl. Dock context menu + painted bitmaps) | `new DockIcon()` throws `#2012`; selection rule and alpha in §3.1 / §7.6 |
| `SystemTrayIcon` | ✅ model (**a real `NSStatusItem` under `--features tray`**) | AIR itself refuses it on macOS (`#2012`) and **by default** so do we; with the enhancement switch on, the same AS3 gets a real status item (see [`enhancements.md`](enhancements.md) §4.11) |
| `NativeApplication.icon` | ✅ | **read-only** (`mxmlc`: "property icon is read-only"); process-wide singleton |
| `NativeApplication.menu` | ✅ | readable and writable; `= null` **crashes** `adl` — we report and keep the old menu (§7.1) |
| `NativeApplication.autoExit` | ✅ | real: with `false` and no visible window the process stays alive |
| `supportsDockIcon` / `supportsMenu` | ✅ | `true` only under `ASC_USE_WINDOW && __APPLE__` (§2) |
| `supportsSystemTrayIcon` / `supportsStartAtLogin` / `supportsDefaultApplication` | ✅ always `false` (`supportsSystemTrayIcon` is `true` under `--features tray`) | matches what this backend actually implements by default (§2); the tray switch is in [`compile.md`](compile.md) §3.4.5 |
| `NativeMenu` / `NativeMenuItem` | ✅ all members | list semantics, error codes and copy semantics match `adl` (§4, §5) |
| `NativeMenu.display()` | ⚠️ reported | no modal native menu runner in this backend (§7.3) |
| `keyEquivalentModifiers` | ✅ mapped | `15..20` measured one by one, then translated to `NSEventModifierFlags` (§7.2) |

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

### 3.1 Which bitmap actually reaches the Dock (measured)

AIR does **not** hand the whole list to AppKit: it **picks one by a fixed target size** and installs that one.
The rule comes from two-bitmap A/B probes (`temp/dockprobe/`: solid-colour bitmaps, colour sampled out of a
`screencapture`) — only the size pair changes between runs:

| Fed to `bitmaps` (colour) | What actually appeared in the Dock |
|---|---|
| `{32(red), 96(green), 256(blue)}` | **96 (green)** |
| `{64(red), 160(green)}` | **160 (green)** |
| `{16(red), 512(green)}` | **16 (red)** ← 16 beat 512 |
| `{100(red), 150(green)}` | **150 (green)** |
| `{127(red), 129(green)}` | **127 (red)** |
| `{129(red), 127(green)}` | **129 (red)** ← reversing the order flips the winner |
| `{128(red), 130(green)}` | **128 (red)** |
| `{128×400(red), 200×200(green)}` | **200×200 (green)** ← the one with width 128 lost |

Those eight runs pin the rule down to one sentence: **minimise `|max(width, height) − 128|`, ties go to the
earlier entry**.
- "16 beats 512" rules out "biggest wins"; "160 beats 64" rules out "largest ≤ 128";
- two entries 2 px apart swap winners when the order is reversed (127/129) ⇒ **ties go to the earlier one**,
  and the target is exactly **128**;
- 128×400 loses to 200×200 ⇒ the metric is the **per-axis maximum**, not the width.

Everything else about painting, measured the same way:

| Case | `adl 51.4.1` | Ours |
|---|---|---|
| Re-assigning `bitmaps` | **repaints immediately** (no restart, no focus change) | same (drawn in the setter) |
| `bitmaps = []` | restores the **default application icon** (does not keep the last one) | same (`setApplicationIconImage:nil`) |
| Semi-transparent bitmap | alpha honoured (the Dock shows through) | same (premultiplied, §7.6) |
| Non-square bitmap | drawn to fit the square tile, aspect kept | same |

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

### 7.2 `keyEquivalentModifiers` → `NSEventModifierFlags`: the measured table

What the six legal values (`15..20`) mean was **measured, not looked up** — this SDK ships no
`flash.ui.KeyboardModifier` class at all (verified against `airglobal.swc` and `mxmlc`), so behaviour is the
only oracle: `temp/keyeqprobe/` (`adl 51.4.1`) installs a real menu bar, gives each of six items one value,
presses synthesized keys through System Events to see which item gets `select`ed, and grabs the open dropdown
with `screencapture` to read the **glyph column**.

| Value | Meaning | Keys that fire it | Dropdown shows |
|---|---|---|---|
| 15 | Command | ⌘S | `⌘S` |
| 16 | Shift | ⇧S | `⇧S` |
| 17 | Control | ⌃S | `⌃S` |
| 18 | Alternate | ⌥S | `⌥S` |
| 19 | no modifier | plain `s` | `S` |
| 20 | **inert** | **nothing fires it** | `S` |

Three further measurements: an **empty array `[]` behaves like `[19]`** (plain `s` fires); **`[15,20]` behaves
like `[15]`** (⌘S fires, 20 contributes nothing); **`[19,20]` reads back as `[20]`** and never fires.

Implementation: the generated C folds the array into five portable bits
(`AS_KEM_CMD/SHIFT/CTRL/OPT/DEAD`), and the glue's `sk_menu_apply_mods` (`vendor/window_glue.cc` and
`vendor/statusitem_glue.cc`, one copy each) turns them into `setKeyEquivalentModifierMask:`.
`20` on its own becomes **`NSEventModifierFlagFunction`**: AppKit draws no glyph for it and the four standard
modifiers cannot produce it, which reproduces both observables — "shows `S`" and "never fires" (how AIR does it
internally is **not observable**; only those two outcomes were measured).
(The `DockIcon.bitmaps` gap that used to sit here was paid off in stage 256 — see §3.1.)

### 7.3 The modal contract of `NativeMenu.display()`

`display(stage, x, y)` shows a **modal** native menu in AIR: it **blocks until the menu is picked or
dismissed**, and the selection event is delivered before it returns. Cocoa gets this for free from
`-[NSMenu popUpMenuPositioningItem:atLocation:inView:]`, which runs a nested tracking loop, so this backend
does **not** need a nestable modal pump in its main loop. `sk_menu_popup` therefore reports two things:
`tag` (which item was picked) and **sync vs async** (Cocoa/Win32 are synchronous; web is not, and
`sk_menu_popup_take` samples it frame by frame).

The pointer position **at the moment the menu disappears** comes back through `sk_menu_popup`'s `outx/outy`
out-params (Cocoa `SDL_GetGlobalMouseState`, Win32 `GetCursorPos`): that is where AIR **replays** the
`rightMouseUp`/`rightClick` the popup swallowed — at the dismissal point (the item / the outside click), not
at the press point. The **emitter** performs that replay (only it knows the selection order), and it happens
**before** the selection events.

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

### 7.6 Semi-transparent pixels: AIR multiplies alpha **twice**, we multiply once (deliberately)

One bitmap (128×128: top-left `0xFF0000FF` opaque blue, top-right `0xFFFF8000` opaque orange, bottom-left
`0x800000FF` 50% blue, bottom-right `0x80FF8000` 50% orange) was given to `adl` and to an AOT build, and the
same Dock tile was sampled in both screenshots:

| Quadrant | `adl 51.4.1` | Ours |
|---|---|---|
| opaque blue / opaque orange | `(0.2, 0.2, 244.7)` / `(238.8, 134.9, 50.7)` | **identical** |
| 50% blue | `(36.9, 61.0, 122.3)` | `(36.9, 61.0, 183.6)` |
| 50% orange | `(92.2, 81.8, 57.7)` | `(152.0, 115.7, 72.8)` |

Split apart: the **background term is identical** (`(1-a)·bg` matches on both sides, so alpha itself is
fine); only the **source term is multiplied by `a` one extra time** (`adl` renders `a²·src + (1-a)·bg`, correct
compositing is `a·src + (1-a)·bg`). AIR hands AppKit bytes that are **already premultiplied** while declaring
them straight-alpha, and AppKit multiplies again ⇒ semi-transparent pixels come out **darker** (the classic
double-premultiply artifact).

**We premultiply once (correct compositing).** This is a conversion artifact, not AIR-*defined* behaviour;
reproducing it would mean deliberately shipping a darkening bug (visible as dark fringes on the antialiased
corners of an icon). Opaque pixels are **byte-identical** on both sides, so ordinary icons look the same; the
difference only shows on pixels with alpha. **Registered in `TODO.md` (遗留待开发)** — not silent.

### 7.7 Right-click menus: what `contextMenu` binds, and what cannot be matched

The `DisplayObject.contextMenu` right-click path is implemented: `rightMouseDown` → walk the ancestor chain
to the nearest object owning the menu → `ContextMenuEvent.MENU_SELECT` (dispatched on the **menu**,
`mouseTarget` is the hit display object, `preventDefault()` is a **no-op**) → popup → replay of the swallowed
release → selection events (`Event.SELECT` on the item → `Event.SELECT` on the menu with `target` still the
item → `ContextMenuEvent.MENU_ITEM_SELECT` on the item). With `contextMenu = null` there is **no**
`MENU_SELECT`, but the right-button events still fire.

**Two divergences that must be stated up front**:

1. **web**: the popup is a DOM overlay; `sk_menu_popup` returns "pending" immediately and the result is
   collected by `sk_menu_popup_take` on a later frame ⇒ `MENU_SELECT` and the selection events land on
   **different frames**, and there is **no** release replay (that is an artefact of modality). The browser's
   own context menu is suppressed by a DOM `contextmenu` listener calling `preventDefault()` (emsdk 3.1.44 has
   **no** `emscripten_set_contextmenu_callback`). On the web **only the root menu** pops up; nested submenus
   are not implemented.
2. **Windows**: the Win32 branch of `vendor/window_glue.cc` uses `TrackPopupMenuEx` + `GetCursorPos`, mirroring
   Cocoa, but **there is no Windows machine here, so it is unverified** beyond "it compiles".

**One internal dependency**: `sk_resync_right_button()` calls `SDL_SendMouseButton()` to clear the SDL mask
that thinks the right button is still held down — without it the **second right-click delivers nothing** (the
popup ate the real release, so SDL's mask stays set). That symbol is SDL **internal** (absent from the public
headers) and must be re-checked when the SDL version is bumped; the `SDL_MOUSEBUTTONUP` it manufactures is
swallowed by `g_synth_right_up`, so AS3 only ever sees the pair the emitter replays.


## 8. Verification and evidence

| Item | Evidence |
|---|---|
| **`ContextMenu` object model, 26 lines** (byte-identical to `adl`) | `examples/context-menu.as` (AOT `--run`) × `temp/ctxprobe/api/ApiEx.as` (the same program, `adl` build): 26/26 lines agree; `test/unit/context-menu.ts` (`unit: context-menu/Model`, 25 pins) pins the single list, the three ContextMenu-only rules, the `#2007` message and the popup ordering |
| **Right-click popup, 7 live steps** (macOS) | `temp/ctxmenu/drv.py`: `open`/`pick0`/`pick1`/`twice`/`esc`/`outside`/`nul` — the LR matches `adl` field by field (`rightMouseDown → MENU_SELECT → rightMouseUp → rightClick → the three selection events`), replay coordinates land at the dismissal point (item 148,111 / press 116,98 / outside 348,259); `temp/ctxmenu/{m5-inv,crop-inv}.png` show `visible=false` not rendered, `enabled=false` greyed, `separatorBefore` drawn |
| 69 model assertions (pure-C build, no window backend) | `examples/native-menu.as` → `native-menu: 69 checks passed` |
| 39 source-level pins + 16 painting pins | `unit: emit/NativeMenu` and `unit: emit/DockIconImage` in `test/unit/emit.ts` |
| **8 selection-rule runs** | `temp/dockprobe/`: `{32,96,256}→96`, `{16,512}→16`, `{129,127}→129`, `{128×400, 200×200}→200×200` … (§3.1) |
| **Painting / alpha / clear / repaint** | `temp/dockquad.as` (AOT) × `temp/dockprobe/Main.as` (`adl`): opaque pixels **identical**, 50% blue `183.6` vs `adl` `122.3` (§7.6), default icon back after `bitmaps=[]`, colour changes immediately on re-assign |
| Real menu bar and real click | `temp/G4App.app` (`NSPrincipalClass=NSApplication`): AX reads `Apple, G4App, Prune`; clicking `Prune → PruneTwo` really ran the AS3 `SELECT` listener (wrote `/tmp/g4click.txt` = `two`) |
| Dock context menu | `sk_menu_install_dock` swizzles `applicationDockMenu:` onto SDL's delegate (the actual right-click is not automated) |
| `autoExit=false` residency | same bundle: the process survives closing the window until `NativeApplication.exit()` |
| Main-menu shape comparison | `probe8.txt` (`adl`: `Apple, Alpha, Beta`) vs the same model in an AOT app (§7.4) |

---

## 9. Not done (out of scope for this stage)

- ~~**G4b: the macOS menu-bar `NSStatusItem`**~~ — **implemented (stage 260)**: an **enhancement** (AIR has no
  macOS equivalent: `supportsSystemTrayIcon` is `false`), so it ships as the opt-in named switch
  `--features tray`; the default artifact stays verbatim AIR (`false` + `#2012`). Behaviour, coordinate rules,
  real-machine evidence and known limits are in [`enhancements.md`](enhancements.md) §4.11 and
  [`compile.md`](compile.md) §3.4.5.