# Real-App Gap Closure · Implementation Plan (WBS)

> This is the **construction plan** that slices the compiler gaps exposed while AOT-compiling a
> **real video-meeting application** into subsystem-batched, buildable stages.
> Three evidence sources: [`stubs.md`](stubs.md) (the shell/no-op inventory), the generated C of the
> real app's `--air-app` main build, and a site-by-site cross-check against the app source.
> Division of labour with [`stubs.md`](stubs.md): stubs answers "what we **can/cannot** produce today";
> this file answers "**in what order to fill the gaps, which file/section to change, how to accept**".
>
> **Classification (AGENTS.md §1.5)**: every gap listed here is an **AIR-defined standard API** —
> `adl` runs it correctly and we don't ⇒ all are **residual defects** (go to `TODO.md` "遗留待开发"),
> **not enhancements** (not [`enhancements.md`](enhancements.md)).
>
> **Naming convention**: per the private-project convention this file refers to the commercial app as
> "**the real app**" and **does not contain its project name or identifiable source paths**; app-side
> usage is described by **function** only (meeting snapshot, mic-volume monitoring, device UUID, …).
> Compiler-side evidence carries precise `file:line`.
>
> Status: **in progress** (opened 2026-11-15). Baseline `v0.4.395` (stage 419).
> **Progress**: **C1 landed** (stage 420, `v0.4.396`; contract in `flash-net.md` §6.10.5); **A1 landed** (stage 421, `v0.4.397`, real PNG encoding; contract in `stubs.md` §4 and `examples/png-encode.as`); **E1+E2 landed** (stage 422, `v0.4.398`, openWith + systemIdleMode; contract in `stubs.md` §4 and `examples/desktop-integration.as`); **A2 landed** (stage 423, `v0.4.399`, real JPEG encoding, **no Skia rebuild needed**; contract in `stubs.md` §4 and `examples/jpeg-encode.as`); **B1a landed** (stage 424, `v0.4.400`, real Microphone device enumeration; contract in `stubs.md` §4 and `examples/microphone-devices.as`); **B1b landed** (stage 425, `v0.4.401`, Microphone capture + SampleDataEvent; contract in `stubs.md` §4 and `examples/microphone-capture.as`); **B2 landed** (stage 426, `v0.4.402`, real Camera device enumeration; contract in `stubs.md` §4 and `examples/camera-devices.as`); **D1 landed** (stage 427, `v0.4.403`, Bitmap/TextField pixel masking; contract in `stubs.md` §4 and `examples/pixel-mask.as`); **D2 landed** (stage 428, `v0.4.404`, cacheAsBitmapMatrix cache-under-matrix + inverse blit; contract in `stubs.md` §4 and `examples/cache-matrix.as`); the other milestones are pending.

---

## 0. Platform & priority

- **The real app is Windows-x86** (descriptor `architecture=32`), so this plan is **Windows-first**;
  macOS parity lands where feasible, and existing pure-POSIX implementations (e.g. `getifaddrs`) are
  not redone. The dev machine is currently Windows, so most stages can be verified locally.
- **Subsystem batching**: image encoding / media capture / network & device info / rendering & masks /
  desktop integration / diagnostics, one batch each (§4); within a batch, order by "impact × cost".
  The recommended cross-batch execution order is in §5.
- **Stage numbers & versions**: one patch version per stage (`v0.4.x → v0.4.x+1`). This file uses
  milestone IDs `A1…F1`; **actual stage numbers are assigned at landing** (parallel tracks may take
  numbers), so they are not hard-coded here.

---

## 1. Verified baseline (2026-11-15)

Checked against the code before starting, to avoid redoing what already exists. The **"not a gap"**
rows matter most — they appear in the generated C as dead-code fallbacks and are easily misread as gaps.

| Fact | Location | Implication |
|---|---|---|
| **`BitmapData.encode` is a no-op for BOTH JPEG and PNG** | `src/emit.ts:24176` `BitmapData_encode`: identifies the compressor then `as_shell_unsupported`, **writes no bytes** | Both formats need filling; the comment admits the PNG encoder is already linked |
| **`SkPngEncoder` is already linked into the glue** | `vendor/skia_glue.cc:133` `#include SkPngEncoder.h`, `:1829` `SkPngEncoder::Encode` | **PNG is low-hanging fruit**: wire it up, no Skia rebuild |
| **Skia has JPEG/WebP encoding disabled** | `skia_use_libjpeg_turbo_encode=false` / `_libwebp_encode=false` (`emit.ts:24172` comment) | JPEG needs Skia encoding enabled or a separate libjpeg-turbo link (§4 batch 1 A2) |
| **`Microphone` is a shell class** | `src/symbols.ts` `shell('Microphone')`; `getMicrophone()` returns `null`, `names` empty, `isSupported=false` | Needs an audio-capture backend + frame-boundary `SampleDataEvent` dispatch |
| **`Camera.getCamera`/`names` report unsupported** | `src/emit.ts:16461` `Camera_getCamera_static` returns `NULL` | Device enumeration needs a backend; the real app's video capture goes through an ANE, enumeration is a separate need |
| **`NetworkInfo.findInterfaces` is real only under `__APPLE__`** | `src/runtime.ts:15103` `as_net_scan` uses `getifaddrs` (`#if defined(__APPLE__)`); `#else` (`:15188`) reports unsupported, returns empty | **Falls through on Windows**: needs `GetAdaptersAddresses` (§4 batch 3 C1) |
| **`DisplayObject.mask` is bounding-box precision only** | generated C reports "a Bitmap/TextField used as a mask (stencilled by its box, not its pixels)" | Bitmap/TextField masks need a pixel template; the vector clipDepth mask is a separate, implemented path |
| **`cacheAsBitmapMatrix` is stored but unused** | `src/emit.ts:13294-13298`: getter returns the set matrix, but the renderer caches at the object's own resolution | The renderer must honour the matrix |
| **`File.openWithDefaultApplication` is a shell** | `src/emit.ts:21013` reports unsupported | Wire `ShellExecute`/`NSWorkspace.open` |
| **`systemIdleMode` is a string round-trip only** | `src/emit.ts:13053-13063`: get/set round-trips but **no OS effect** | Wire `SetThreadExecutionState`/`IOPMAssertion` |
| **`Error.getStackTrace` returns an empty string** | `src/emit.ts:12038-12042` reports unsupported, returns `""` | Needs an AS3 stack-frame model (captured at throw) |
| **`BitmapData.applyFilter` throws for DropShadow/Glow** | `src/emit.ts:24189`: `not implemented`; BlurFilter is implemented | Add rasterization for the two filters |
| **`NativeProcess` is implemented (NOT a gap)** | `src/native-process.ts:272` `CreateProcessW`, `:486` `as_np_start`; `emit.ts:4576` wired | The "no process backend" line in the generated C is **dead code for backend-less builds**; all 13 real-app references work |
| **`NativeDragManager` native session wired, Windows unverified** | `stubs.md` §2.2; `desktop-file-interaction.md` | This is "verify/complete", not "build from scratch" |

---

## 2. Gap inventory (app-function evidence × class × batch)

App side is described by function only (naming convention above). **The class column is "residual"
throughout** (§1.5).

| # | Gap | Real-app function (generic) | Impact | Batch·stage |
|---|---|---|---|---|
| 1 | `BitmapData.encode` PNG | image export / PNG snapshot | high (encode fully stubbed) | batch 1 A1 |
| 2 | `BitmapData.encode` JPEG | **meeting snapshot** (high-quality JPEG) | high | batch 1 A2 |
| 3 | `BitmapData.applyFilter` DropShadow/Glow | bitmap filter processing | low (1 call site) | batch 1 A3 |
| 4 | `Microphone.getMicrophone` + `SampleDataEvent` | **admin/speaker mic-volume monitoring** | high (silently swallowed by try/catch) | batch 2 B1 |
| 5 | `Camera.getCamera` / `Camera.names` | camera device enumeration/selection | medium (video capture via ANE) | batch 2 B2 |
| 6 | `NetworkInfo.findInterfaces` (Windows) | **NIC MAC for device UUID** | high (empty on Windows) | batch 3 C1 |
| 7 | `DisplayObject.mask` pixel precision | UI masks (17 `.mask=` sites) | medium | batch 4 D1 |
| 8 | `DisplayObject.cacheAsBitmapMatrix` | cached-render optimization (7 sites) | medium-low | batch 4 D2 |
| 9 | `File.openWithDefaultApplication` | open file with default app (2 sites) | medium | batch 5 E1 |
| 10 | `NativeApplication.systemIdleMode` | keep-awake during long loads/meeting | low | batch 5 E2 |
| 11 | `NativeDragManager` (Windows) | drag-and-drop (1 site) | low | batch 5 E3 |
| 12 | `Error.getStackTrace` | error diagnostics (2 sites) | low | batch 6 F1 |

---

## 3. Scope

### 3.1 In scope (the 12 items)

All of §2. On landing each item: the matching `stubs.md` row moves to "graduated", `TODO.md` residual
table is accounted ("removed/rewritten"), and an example + unit pins are added.

### 3.2 Out of scope (look like gaps, but do not affect the real app)

| Item | Reason |
|---|---|
| `StageWebView` | The real app uses its own `NativeWindow` wrapper + a WebView **ANE**, not the built-in `StageWebView` |
| `air.net.WebSocket` | The real app keeps a WebSocket **ANE**; the compiler-side `air.net.WebSocket` is already implemented (stage 413) |
| RTC audio/video capture/render | Goes through the RTC **ANE**; this plan only fills built-in needs outside the ANE (enumeration/volume monitoring) |
| `NativeProcess` | **Already implemented** (`native-process.ts`), not a gap |
| `LocalConnection` | AIR itself **has no such transport** (a Flash Player feature); the shell is the correct answer; the real app uses it as an "is-local" probe |
| `SecureSocket` TLS | A gap, but the real app is **deleting that fallback path** (its WebSocket migration plan); not filled |
| `air.security.Digest` | A gap, **zero consumers**; not filled |
| `FileReference.download` | **0 references** in the real app; not filled |
| `ByteArray` Base64 trio | **Already added in stage 416** (`toBase64`/`writeBase64`/`createFromBase64`) |

---

## 4. Subsystem batches & milestones

> Per-stage universal acceptance (DoD, AGENTS.md §4): `examples/*.as` runs with correct output +
> `test/unit/` structural pins + full `node test.ts` unbroken + zh/en docs synced + version bump +
> `TODO.md` accounting. The "acceptance" below lists only the **stage-specific** executable criteria.
> Effort is an **estimate** including real-machine verification; media/render items carry hardware
> dependency risk (§7).

### Batch 1 · Image encoding (`BitmapData`)

| Stage | Content | File-level target | Specific acceptance | Est. | Platform |
|---|---|---|---|---|---|
| **A1 PNG encode** ✅ **landed (stage 421, v0.4.397)** | Wire the PNG branch of `BitmapData_encode` to the already-linked `SkPngEncoder` (new memory variant `sk_image_encode_png_mem`), write back to `ByteArray`. **Measured signature is 3 params `(rect, compressor, byteArray=null)`, no `byteArrayOffset`** (the old 4-param model was corrected); writes at the current `position`, advancing it / extending `length` | `emit.ts` `BitmapData_encode`; `skia_glue.cc` memory-encode seam | opaque pixels round-trip **exactly**; `position`/`length` per AIR; PNG magic `89 50 4E 47`; null rect/compressor `#2007`, null byteArray silent; semi-transparent goes through premultiply rounding (AIR too, logged deviation) | 0.5 d | all |
| **A2 JPEG encode** ✅ **landed (stage 423, v0.4.399)** | **No Skia rebuild needed**: the vendored `libjpeg.lib` already carries the compressor symbols, so drive the libjpeg-turbo C API directly (`sk_image_encode_jpeg_mem`, own memory destination), wiring `JPEGEncoderOptions.quality` (uint default 80, >100 raises #2006) | `vendor/skia_glue.cc` + `emit.ts` encode JPEG branch | different `quality` yields different decodable bytes; premul-over-black alpha drop byte-identical to AIR; **whole image-example regression green** (694/690) | 1–2 d | all |
| **A3 applyFilter shadow/glow** ✅ **landed (stage 429, v0.4.405)** | Rasterize `DropShadowFilter`/`GlowFilter` (BlurFilter keeps its CPU box blur): reuse the same Skia image-filter seams as the `DisplayObject.filters` path -- draw the source region into a padded surface, apply the filter via a saveLayer paint, read the pixels back and blit anchored at `destPoint` | `emit.ts` `BitmapData_applyFilter` (throw removed) | pixel diff ≤ tolerance vs AIR at same params (shadow offset/blur, glow halo and hideObject shadow-only match byte-for-byte; glow fringe alpha differs by 8, within blur tolerance); unknown-filter no-op and a loud non-Skia fallback kept | 1–2 d | all |

Within-batch order: **A1 → A2 → A3** (A1 lands first with zero rebuild; A2 landed — measured **no Skia rebuild needed**, the vendored libjpeg.lib carries the compressor symbols; **A3 landed**, stage 429). **Batch one fully landed.** WebP encode is **deferred** (unused by the real app).

### Batch 2 · Media capture (`flash.media`)

| Stage | Content | File-level target | Specific acceptance | Est. | Platform |
|---|---|---|---|---|---|
| **B1a Microphone device face** ✅ **landed (stage 424, v0.4.400)** | Real `names`/`isSupported`/`getMicrophone`/`getEnhancedMicrophone` (Windows WASAPI `as_mic_scan`: `eCapture`/`DEVICE_STATE_ACTIVE`, friendly names byte-identical to AIR); AIR defaults (rate 8/gain 50/codec nellymoser etc.), index<0 -> 0, out-of-range null; removed the invented `fps`/`setCodec`/`setRate` (describeType confirms AIR has none) | `runtime.ts` `as_mic_scan` seam + `emit.ts` static-member overrides + `symbols.ts` de-invent; `ole32` linked per target | device face byte-identical to AIR (`temp/micprobe` A/B); platform-aware example passes on a device-less CI; **694+ regression green** | 0.5 d | Win first |
| **B1b Microphone capture** ✅ **landed (stage 425, v0.4.401)** | capture thread → queue under lock → **frame-boundary `SampleDataEvent` dispatch** (same shape as WebSocket/Socket; no AS3/GC on worker threads); `setSilenceLevel`/`setUseEchoSuppression` real setters, live `activityLevel` 0..100 | Win WASAPI shared-mode capture glue (mix format downmixed + linearly resampled to rate kHz); GC roots `as_mic_mark_roots` + `as_mic_dispatch` (emitted by emit.ts) | contract matched against adl 51.4.1: 2048 big-endian float32 per event (data.length 8192), position advancing by 2048, activityLevel tracks sound pressure; platform-aware example passes on a device-less CI; **696+ regression green** | 2–4 d | Win first |
| **B2 Camera enumeration** ✅ **landed (stage 426, v0.4.402)** | `Camera.names`/`getCamera(name)` device enumeration (**capture still via ANE**; no video stream this stage) | Windows DirectShow `as_cam_scan` (`CLSID_VideoInputDeviceCategory`; ICreateDevEnum declared by hand, ocidl.h, GUIDs by hand avoid strmiids, PropVariant avoids oleaut32); mac AVFoundation deferred | `names` lists real devices (byte-identical to AIR), `getCamera` resolves by name/index-as-string (null -> first, out-of-range/bad -> null), `isSupported` a real value, read-only name/index; platform-aware example passes on a device-less CI; **698+ regression green** | 1–2 d | Win first |

Within-batch order: **B1 → B2** (B1 high impact). B1 splits into B1a (device face, **landed**, stage 424) and B1b
(capture+events, **landed**, stage 425; hard-depends on the B1a device face) as two stages to reduce risk.
**B2 landed** (stage 426, Camera device face; capture still via ANE).
**Red line**: capture callbacks must not touch AS3/GC on worker threads; new box tags/roots must sync
the four GC sites (AGENTS.md memory red lines).

### Batch 3 · Network & device info (`flash.net`)

| Stage | Content | File-level target | Specific acceptance | Est. | Platform |
|---|---|---|---|---|---|
| **C1 findInterfaces Windows** ✅ **landed (stage 420, v0.4.396)** | Add an `ASC_NET_WIN32` branch to `as_net_scan`: enumerate adapters via `GetAdaptersAddresses`. **Measured Windows semantics differ from POSIX** (GUID name / FriendlyName / uppercase `-` MAC / `OperStatus` active / natural unicast order, not "IPv4 first within"), aligned line-for-line with adl 51.4.1 | `runtime.ts` `as_net_scan`; link `iphlpapi` | Windows real machine: 7-adapter full-field diff against adl is empty; `net-interfaces.as` platform-aware passes on both arms; macOS not regressed | 0.5–1 d | Win (mac exists) |

Only C1 in this batch. **Low-hanging fruit + high impact** (device UUID); recommended to do first
across batches (§5).

### Batch 4 · Rendering & masks (`flash.display`)

| Stage | Content | File-level target | Specific acceptance | Est. | Platform |
|---|---|---|---|---|---|
| **D1 mask pixel precision** ✅ | Clip by **pixel alpha** when a Bitmap/TextField is the mask (applied when the content sets cacheAsBitmap: both cached -> soft alpha, content-only -> binary stencil); leave the vector clipDepth path alone. **Landed** (stage 427): content saveLayer + mask rasterization + `kDstIn` composite (`sk_surface_threshold_alpha` binarization); adl pixel A/B binary exact, soft alpha within tolerance | renderer mask path (`skia_glue.cc` dstin/threshold + `emit.ts` `as_mask_pixel_composite`) | pixel diff ≤ tolerance vs AIR for the same mask (round/text mask aliased edges); sample-regress the 17 sites | 2–3 d | all |
| **D2 cacheAsBitmapMatrix** ✅ | Renderer honours the set matrix: cache under the matrix + inverse blit, **picture identity**, only the cache resolution scales with the matrix. **Landed** (stage 428): `as_render_cached` gated on a non-identity matrix, bounds = transformed AABB, surface concat M, blit concat M^-1; getter keeps the round-trip. adl desktop CPU mode no-ops it itself (getter null); scale/translate/identity pixel A/B identical | `emit.ts` `as_render_cached`/setter | cache resolution/transform matches AIR after setting the matrix; getter round-trip unchanged | 1–2 d | all |

Within-batch order: **D1 → D2** (D1 larger impact). Both touch the renderer, so **the whole
render/text example set must be re-verified on both ends** (per the stage-418 device-font lesson).
**D1 landed** (stage 427); **D2 landed** (stage 428) -- batch four fully landed.

### Batch 5 · Desktop integration

| Stage | Content | File-level target | Specific acceptance | Est. | Platform |
|---|---|---|---|---|---|
| **E1 openWithDefaultApplication** ✅ **landed (stage 422, v0.4.398)** | Reuse the `as_open_external` seam (Win `ShellExecuteW` / mac `open` / Linux `xdg-open`). **Measured**: empty File raises `#1009` (its own code, not the usual `#2037`), missing path `#3003`, a directory opens | `emit.ts` `File_openWithDefaultApplication` | opens the default app on a real machine (directory success path verified); error contract aligned with adl | 0.5 d | Win first |
| **E2 systemIdleMode** ✅ **landed (stage 422, v0.4.398)** | `KEEP_AWAKE` wires `SetThreadExecutionState` (Win) / `IOPMAssertion` (mac); `NORMAL` releases. **Measured**: null raises `#2007` (idleMode), invalid value `#2008` | `emit.ts` setter + runtime `as_set_idle_mode` | system idle timer suppressed after `KEEP_AWAKE` (real machine / power API observation); get/set round-trip unchanged | 0.5 d | Win first |
| **E3 NativeDragManager Windows** ✅ **landed (stage 430, v0.4.406)** | Verify/complete OLE drag-drop: align the `doDrag`/`acceptDragDrop`/`dropAction` error/no-op contract with adl (outside a session the setter/acceptDragDrop are silent no-ops; doDrag throws #2007 only for a null clipboard); the drag-in/out session state machine is unchanged | `src/native-drag.ts` (shared mac/Win) | error/no-op contract byte-identical to adl (`unit: desktop/native drag`, two cases); drag-in measured earlier, drag-out external acceptance and dragImage need a real machine (dragImage private protocol registered in the residual table) | 2 d | Win |

Within-batch order: **E1 → E2 → E3** (E1/E2 are half-day wins; **E3 landed**, stage 430, contract alignment + session-state verification). **Batch five fully landed** (drag-out external acceptance / dragImage need real-machine visual checks, registered in the residual table).

### Batch 6 · Diagnostics

| Stage | Content | File-level target | Specific acceptance | Est. | Platform |
|---|---|---|---|---|---|
| **F1 Error.getStackTrace** ✅ **landed (stage 431, v0.4.407)** | A runtime TLS shadow stack (`as_astack_enter/leave`) pushes at function entry, leaves at return and restores depth at catch/frame boundaries; an Error snapshots the stack **at construction** (private `_stacktrace` field) and `getStackTrace` returns AIR's text format. **Compile-time opt-in since stage 434 (v0.4.410)**: the shadow stack is emitted only when the compilation references `getStackTrace` (the `ASC_STACKTRACE` macro gates enter/leave); otherwise the bodies are empty and -O2 inlines them away — fixing fib's per-call regression (4.54×→1.03×) while programs that use the API keep full F1 semantics | `runtime.ts` shadow stack + `emit.ts` function-emission sites + `symbols.ts` Error field | AS3-authored frames match adl frame-by-frame at the same throw point (`temp/stackprobe`); null when no stack; the ADL loader frames are a different source, replaced by a `global()` script frame | 2–3 d | all |

Only F1. Depends on an "AS3 stack-frame model" — the **only item needing a new runtime representation**;
risk in §7 — **landed** (stage 431). **Batch six complete; all 12 plan milestones (C1/A1/A2/A3/B1a/B1b/B2/D1/D2/E1/E2/E3/F1) are now landed.**

---

## 5. Recommended cross-batch execution order

Subsystem batching is the **structure**; landing interleaves by "impact × cost", taking quick wins and
high impact first:

1. ~~**C1** (NIC Windows, 0.5–1 d, high-impact quick win)~~ ✅ **landed** (stage 420, v0.4.396)
2. ~~**A1** (PNG encode, 0.5 d, zero-rebuild quick win)~~ ✅ **landed** (stage 421, v0.4.397)
3. ~~**E1 + E2** (openWith + systemIdleMode, 0.5 d each, desktop wins, can regress together)~~ ✅ **landed** (stage 422, v0.4.398)
4. ~~**A2** (JPEG snapshot, 1–2 d, high impact, needs Skia rebuild)~~ ✅ **landed** (stage 423, v0.4.399, measured no Skia rebuild needed)
5. **B1** (mic-volume monitoring, high-impact large item) — **B1a device face ✅ landed** (stage 424, v0.4.400); **B1b capture+events ✅ landed** (stage 425, v0.4.401)
6. **B2** (camera enumeration, 1–2 d) — **✅ landed** (stage 426, v0.4.402, real Camera device enumeration; capture still via ANE)
7. **D1 → D2** (render mask/cache matrix, whole render regression)
8. **A3** (applyFilter shadow/glow)
9. **E3** (drag-drop Windows verification)
10. **F1** (getStackTrace, needs a new stack-frame model, last)

> This order is a **suggestion**, not a hard dependency; the only hard dependencies are A2 on the Skia
> rebuild chain being ready, and B1b on B1a's device surface.

---

## 6. Acceptance & accounting (per stage close-out)

- **Three things** (AGENTS.md §2.7): full `node test.ts` regression unbroken + update zh/en README +
  bump the patch version.
- **Pin layering**: behavioural criteria go to `examples/*.as` (auto-registered); negatives/structural
  invariants go to `test/unit/`. For media with no hardware, use "no device → `isSupported=false`
  reported loudly" as the runnable criterion; real-device capture is recorded separately.
- **stubs.md linkage**: each filled item moves its §2/§3 row to the "graduated" table with the stage number.
- **TODO.md accounting**: each stage note states "added/rewritten/removed N rows" and recounts actual
  table rows; gaps in this file are removed from the residual table once landed.
- **Platform stance**: Windows-first items must be verified on Windows real hardware; macOS-parity
  items note whether they land in the same stage or a separate one.

---

## 7. Risks & open items

| Item | Risk | Mitigation |
|---|---|---|
| **A2 Skia rebuild** | Enabling `libjpeg_turbo_encode` needs a Skia rebuild; Windows vendored libs must keep **MSVC ABI**; rebuild affects all image paths | A1 first to validate glue wiring; after A2 rebuild **regress the whole image set**; or link libjpeg-turbo separately to avoid a Skia rebuild |
| **B1 capture thread** | Audio callbacks run on a worker thread; touching AS3/GC there crashes | Strictly reuse the WebSocket/Socket shape: queue under lock + frame-boundary `as_mic_dispatch`; new roots/box tags sync the four GC sites |
| **B1/B2 hardware dependency** | Machines without mic/camera cannot verify capture | Two acceptance tiers: no-device report (auto-runnable) + real/virtual-device measurement (manual) |
| **D1/D2 renderer surface** | Touching the renderer easily hits text/image examples (stage-418 device-font caused 22 reds at once) | Re-verify the whole render/text set **on both ends** before close-out |
| **F1 stack-frame model** | Needs a new runtime representation, affects the throw path and GC | Standalone stage, last; measure AIR's stack text format first to fix the contract |
| **32-bit Windows** | The real app is `architecture=32`; some Win APIs' availability on i686 | Re-verify each Win stage on the 32-bit artifact (the TODO residual table already has an "i686 target not buildable" item; confirm the build surface first) |
| **WebP encode** | Unused by the real app | Deferred, not in this round |

---

## 8. Evidence index

- Shell inventory: [`stubs.md`](stubs.md) §2 (shell classes), §3 (member-level reports), §4 (graduated).
- Generated-C reports: the real app's `--air-app` main build (D3D12), `grep -a as_shell_unsupported`
  and the `shell class` banners.
- Compiler-side anchors: see the §1 table (`emit.ts`/`runtime.ts`/`symbols.ts`/`skia_glue.cc`/`native-process.ts`).
- App-side usage: by generic function (naming convention above); the detailed `file:line` mapping lives
  in the workspace `temp/` (non-product-facing) and is not committed with this file.
- Classification principle: [`enhancements.md`](enhancements.md) §2 (residual vs enhancement), AGENTS.md §1.5.