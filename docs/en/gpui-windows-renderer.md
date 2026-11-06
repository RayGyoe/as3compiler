# The GPUI (Zed) Windows Backend: How It Draws UI and How It Accelerates

> **Status: research only. No code changed, no version bump.** This document answers one question: *what does
> a production Rust GUI framework draw with on Windows, and why is it fast?* It is a reference for our own
> Windows backend (Win32 + SDL2 + Skia D3D12, see [`win32.md`](win32.md)); it does **not** argue for
> copying GPUI — see §10 for why.
>
> **Subjects (two sources; their line numbers are not interchangeable)**:
> - `gpui-pre-windows 0.3.11` — a crates.io snapshot of Zed's `crates/gpui_windows`, metadata records
>   `zed@f816e1f`. **The evidence behind §2–§8.**
> - **`gpui-fast`** — longbridge's fork of Zed's GPUI (an experiment in Retained Mode). **The evidence behind
>   §9**, whose full source is on this machine at `asaotui/gpui-fast-src/`, main branch `046a859`
>   (2026-11-06, `fast: forget released entities in a spliced view's dependencies (#106)`), based on zed
>   `7960b2a7` (see its `UPSTREAM`). The previous §9 read the `gpui-fast-windows 0.1.13` crates.io package
>   instead; **those paths and line numbers are dead**, and §9 has been rewritten from the fork itself.
>
> How the sources were obtained:
>
> ```sh
> # §2–§8: the Windows backend snapshot (unpacked under temp/gpui/, scratch, not committed)
> git clone --depth 1 https://github.com/longbridge/gpui-kit.git temp/gpui/gpui-kit
> curl -sL -o gpui-pre-windows.crate \
>   https://crates.io/api/v1/crates/gpui-pre-windows/0.3.11/download   # plus three other crates
>
> # §9: the gpui-fast main branch (inside the asaotui workspace, .gitignore'd; same command as
> # asaotui/README "preparation after cloning")
> git clone --depth 1 --filter=blob:none --sparse \
>   https://github.com/longbridge/gpui-fast.git asaotui/gpui-fast-src
> cd asaotui/gpui-fast-src
> git sparse-checkout set crates/gpui crates/gpui_windows crates/gpui_platform docs
> ```
>
> **Line-number convention**: every `file:line` in §2–§8 is relative to `gpui-pre-windows-0.3.11/src/`
> (a `gpui/` prefix means the upstream core crate `gpui-pre-0.3.11/src/`). It is valid only for that pinned
> snapshot (`Cargo.toml` requires the exact `=0.3.11`), and **that snapshot is no longer in the workspace, so
> those numbers are no longer evidence you can check on the spot** — the conclusions still stand, but
> re-checking them means unpacking the snapshot again with the first command above. **Every `file:line` in
> §9 is relative to `asaotui/gpui-fast-src/crates/`** and can be grepped today; §11 lists the commands and
> the expected hits. The same Windows code sits dozens of lines apart in the two sources (e.g.
> `Present(0, DXGI_PRESENT(0))` is `directx_renderer.rs:245` in the 0.1.13 snapshot and `:258` on the fork) —
> **do not mix their line numbers**.
>
> **Division of labour with [`rust-text-backend.md`](rust-text-backend.md) §13**: that section covers **how the
> text stack is split** (who shapes, who enumerates fonts, who rasterizes; it targets the older `gpui 0.2.2` /
> `zed@5447804`). This document covers **how pixels get out** (renderer, atlases, batching, composition, frame
> pacing). Text appears only in §5.2, on the "how it becomes a GPU atlas" side; shaping and line breaking are
> not repeated here.

---

## 0. Executive summary

| Question | Answer | Evidence |
|---|---|---|
| Does it use Direct2D? | **Not at all.** Zero `D2D`/`Direct2D` references in the crate, and the `windows` feature list has no `Win32_Graphics_Direct2D` | `Cargo.toml`; crate-wide grep |
| So what draws? | **D3D11** (a hand-written primitive pipeline) + **DXGI flip swap chain** + **DirectComposition** + **DirectWrite** (glyph rasterization only, never drawing) | `directx_renderer.rs:1-22` |
| Draw calls per frame? | Usually **single digits to a few dozen**: the whole UI collapses into eight primitive kinds, one `DrawInstanced(4, N)` per contiguous same-kind batch | `directx_renderer.rs:373-395, 1214` |
| How is text drawn? | DirectWrite **offscreen** rasterization into bitmaps → three atlases (grayscale / ClearType 3×1 / colour) → blitted as instanced sprites | `direct_write.rs:740-940` |
| How are vectors drawn? | Triangulated → the **whole batch in one** pass into a 4×MSAA intermediate target → resolved → composited back as sprites | `directx_renderer.rs:615-720` |
| How are transparent windows done? | `WS_EX_NOREDIRECTIONBITMAP` + `CreateSwapChainForComposition` + a DComp visual; alpha is left to DWM | `window.rs:516`, `directx_renderer.rs:1298` |
| Frame pacing? | A dedicated thread calls `DwmFlush()` to ride the compositor clock, then `RedrawWindow`; `Present(0,0)` **does not block** | `vsync.rs`, `platform.rs:446`, `directx_renderer.rs:245` |
| Why is it fast? | Upstream's answer is "batch more, issue fewer draw calls"; `gpui-fast`'s is "**an entire frame can do nothing**" — retained views, retained layout nodes, scroll-layer tiles. Frame cost tracks **how much of the window changed**, not how much is on screen | §9 |
| What is "120 FPS"? | Upstream docs explicitly demote it to a **frame-budget statement** (8.33 ms per frame on a 120 Hz panel), not "rebuild 120 times a second" | `gpui-kit/website/docs/fps.md:28` |
| What is portable to us? | ① the **DirectComposition** transparency/composition chain (it fills our unimplemented `<transparent>` on Windows); ② the vsync-thread / non-blocking-Present **decoupling idea**; ③ the structural rule that text and vectors must be batched. **Not** its hand-written pipeline | §10 |

> That it uses D3D11 while we use D3D12 is **not a difference of taste**: Skia m124 has exactly one
> Direct3D backend on Windows (D3D12), and we are unwilling to give up the device/queue we share with
> Stage3D. The full mechanism comparison, the part we hand-wrote for D3D12, and the conditions under
> which D3D11 would be worth revisiting live in [`d3d11-vs-d3d12.md`](d3d11-vs-d3d12.md).

---

## 1. Orientation: the renderer is not in `gpui-kit`

`gpui-kit` is the upper layer (base / component / kit / shell) and contains **no rendering code at all**.
GPUI itself is a pinned upstream snapshot, and the Windows backend lives in a **third crate**:

| Crate | Role | Windows drawing code? |
|---|---|---|
| `gpui-kit` / `gpui-base` / `gpui-component` | components, behaviour, design system | none |
| `gpui-pre` (package name; `use gpui::*`) | engine core: Element / Scene / layout / atlas abstractions | platform-**agnostic** `Scene` plus the `PlatformAtlas` / `PlatformTextSystem` traits; no concrete backend |
| `gpui-pre-platform` | a 20 KB **forwarding layer**: `cfg_select!` wires `current_platform()` to a backend | none (wiring only) |
| **`gpui-pre-windows`** | the real HWND/D3D11/DWrite implementation | **yes** (13k lines; the subject of this document) |
| `gpui-pre-macos` / `gpui-pre-linux` / `gpui-pre-web` | the other three | — |

The shape of this split is itself worth noting: **the engine knows only traits (`PlatformAtlas`,
`PlatformTextSystem`, `PlatformWindow`), and each platform supplies a complete backend.** That is why a full
picture requires four crates under `temp/gpui/`.

---

## 2. Not Direct2D: the five components actually used

The `windows` features that `gpui-pre-windows/Cargo.toml` enables for graphics are exactly:

```toml
"Win32_Graphics_Direct3D11",         # device and drawing
"Win32_Graphics_Direct3D_Fxc",       # runtime HLSL compilation (debug builds)
"Win32_Graphics_DirectComposition",  # visual tree / composition with DWM
"Win32_Graphics_DirectManipulation", # touch and precision-touchpad gestures
"Win32_Graphics_DirectWrite",        # glyph rasterization and fonts
"Win32_Graphics_Dwm",                # dark mode, backdrop material, compositor clock
"Win32_Graphics_Dxgi_Common",
"Win32_Graphics_Hlsl",
```

**There is no `Win32_Graphics_Direct2D`**, and `grep -ri 'd2d\|direct2d'` over the whole crate returns nothing.

| Component | Its job in GPUI | What it does **not** do |
|---|---|---|
| D3D11 | all pixel output: eight hand-written pipelines, instanced draws, MSAA resolve, Present | does not generate geometry (the CPU triangulates and ships a structured buffer) |
| DXGI | flip-model swap chain (`FLIP_SEQUENTIAL`), adapter enumeration | — |
| DirectComposition | attaches the swap chain as a visual so DWM composites it with premultiplied alpha | does not produce pixels |
| DirectWrite | **two things only**: font enumeration/shaping, and `IDWriteGlyphRunAnalysis` to rasterize a **single glyph** into an alpha bitmap | **does not draw text** — there is no on-screen `DrawTextLayout` path |
| DWM | compositor clock (`DwmFlush`), refresh period (`DwmGetCompositionTimingInfo`), system backdrop | — |

### Why not Direct2D

D2D's sweet spot is "**retained geometry objects + few draws**" (a GDI replacement): build an `ID2D1Geometry`
once, reuse it many times, optionally record with `ID2D1CommandList`. GPUI's model is the opposite:

1. **The scene is rebuilt every frame** (immediate-mode element tree → flat primitive arrays), so D2D's
   geometry realizations would be invalidated each time;
2. Its shading requirements are **custom-shader level**: analytic coverage AA (derivatives of a quadratic
   curve), SDF rounded corners and shadows, gamma simulation of ClearType coverage, dual-source subpixel
   sprite blending, COLR layer compositing for emoji. D2D only offers a few fixed modes;
3. D2D is itself built on D3D, so **an extra wrapper buys nothing** while giving up direct control over
   instance buffers and pipeline state.

The same judgement applies to us: **Skia already is "a layer above 2D"**, and stacking D2D on top would be
that layer twice.

---

## 3. The path of one frame

```
 [VSyncProvider thread]                            [UI thread (where WndProc runs)]
 DwmFlush() ──blocks until the compositor clock
   └─► DwmGetCompositionTimingInfo gives refresh period
   └─► for every visible, non-minimized window:
         frame_signal.record(t)
         RedrawWindow(RDW_INVALIDATE)
                              │  (WM_PAINT queued)
                              ▼
                     handle_paint_msg → draw_window
                              │
                     DrawCoordinator::try_begin_draw()   ← re-entrancy guard: nested paint only ValidateRect + defer one frame
                              ▼
                     request_frame(RequestFrameOptions{
                         require_presentation: false, force_render, signal_at, signal_source })
                              ▼
                     gpui core: should_draw = invalidator.is_dirty() || force_render
                              │ clean ──► not even present runs (idle cost ≈ 0)
                              ▼ dirty
                     window.draw() → Entity::render → element tree → layout (taffy) → prepaint → paint
                              ▼
                     Scene { eight primitive arrays + paint_operations }
                              ▼
                     DirectXRenderer::render(scene)
                              ▼
                     upload_scene_buffers → loop over batches → one DrawInstanced(4,N) per batch
                              ▼
                     Present(0, DXGI_PRESENT(0))   ← no vsync wait
```

Key facts:

- **Drawing happens on the UI thread** (inside `WndProc`) using the immediate context; the Windows backend
  runs exactly one extra thread (vsync / device recovery), see §7.
- The entry gate is `let should_draw = invalidator.is_dirty() || force_render;` (`gpui/window.rs:2022`).
  **Idle really is idle** — which skips the entire rebuild chain that "redraw every frame" frameworks pay.
- The re-entrancy guard is at `events.rs:1354`: a nested `WM_PAINT` does not draw a second time, it only
  `ValidateRect`s and sets `force_render_pending`. Otherwise a nested message pump busy-loops on a still
  invalid region.

---

## 4. `Scene`: the whole UI collapsed into eight primitive kinds

`Scene` (`gpui/scene.rs:36-47`) is just a handful of flat `Vec`s:

| Field | Contents |
|---|---|
| `shadows` | shadows (rounded rect + blur radius + inset flag) |
| `quads` | solid/gradient rectangles (corners, borders, per-corner radii, transform) |
| `paths` | vector paths (vertices + draw order + clip bounds) |
| `underlines` | text underlines / strikethroughs and similar segments |
| `monochrome_sprites` | grayscale atlas blits (grayscale glyphs, icons) |
| `subpixel_sprites` | ClearType 3×1 atlas blits |
| `polychrome_sprites` | colour atlas blits (emoji, colour images) |
| `surfaces` | native surface placeholders (**upstream Windows never draws them**, see §8) |
| `paint_operations` / `layer_stack` / `primitive_bounds` | paint order, nested layers, bounding-volume tree |

**How batches are cut** (`Scene::batches()`, `gpui/scene.rs:172`): by **kind + atlas texture id + adjacent
draw order**. Consequently:

- Neighbouring elements of the same kind **merge into one instance range**, drawn with a single
  `DrawInstanced`;
- Inserting a different kind in between (say text that splits a region into two `div`s) **breaks the batch** —
  so keeping the z-order free of kind interleaving is itself an optimisation.

The renderer's batch loop (`directx_renderer.rs:373`) does the same thing for every batch, with a different
pipeline:

```rust
device_context.DrawInstanced(4, instance_count, 0, 0);   // :1214
```

Four vertices form one triangle-strip quad; the shader builds the 0..1 box from
`float2(float(vertex_id & 1), 0.5 * float(vertex_id & 2))` and then **indexes a structured buffer** by
`SV_InstanceID` to fetch this instance's bounds/colour/atlas tile:

```hlsl
StructuredBuffer<MonochromeSprite> mono_sprites: register(t1);
uint sprite_id = batch_start_index + instance_id;   // batch_start_index lives in a constant buffer
```

Instance data is **not** in the input layout; it is a `StructuredBuffer` (SRV) plus a constant buffer holding
the batch start, mapped only when it changes. That is the central trade-off of the design: **the vertex layout
is always four empty vertices and all geometry lives in instance data**, so the eight pipelines share one
input topology and changing a primitive never touches the IA stage.

---

## 5. The four acceleration levers

### 5.1 Batch merging + instancing: CPU draw count decoupled from element count

A typical screen (hundreds of `div`s, thousands of glyphs) is measured at single digits to a few dozen draw
calls. Against an "one draw per element" immediate-mode framework that is the first order of magnitude.

Buffer policy (`directx_renderer.rs:1130-1161`):

- One **dynamic instance buffer** per pipeline, rewritten whole with `D3D11_MAP_WRITE_DISCARD` (`:1644`);
- When too small, it is rebuilt at `next_power_of_two` capacity, capped by
  `MAX_INSTANCE_BUFFER_SIZE = 256 MB` (`:30`);
- The buffer therefore survives across frames and steady state does zero allocation.

### 5.2 Text: offscreen rasterization → atlas → sprites (never "draw text" per frame)

> Shaping, font matching, and line breaking belong to [`rust-text-backend.md`](rust-text-backend.md) §13.
> Only "how pixels reach the GPU" is described here.

Glyph rasterization (`direct_write.rs:740` onwards) uses DirectWrite's **offscreen** API throughout; there is
not a single on-screen draw call:

1. Build a one-glyph run (`glyphCount: 1`, zero advance/offset) with a `DWRITE_MATRIX` scale;
2. `GetRecommendedRenderingMode`, then **map `OUTLINE` to `NATURAL_SYMMETRIC`** (`:795`) — outline mode means
   "let the system draw with hinting", which defeats a stable cacheable bitmap;
3. `IDWriteFactory::CreateGlyphRunAnalysis` → `GetAlphaTextureBounds` → `CreateAlphaTexture`:
   - grayscale uses `DWRITE_TEXTURE_ALIASED_1x1` (one channel);
   - ClearType uses `DWRITE_TEXTURE_CLEARTYPE_3x1` (RGB, i.e. three subpixel phases);
4. The bitmap goes into an atlas (`directx_atlas.rs:1`, allocator `etagere::BucketedAtlasAllocator`; three
   atlases **split by pixel format**: mono / subpixel / poly);
5. Drawing only blits a sprite by atlas tile (`shaders.hlsl:1184` / `:1194` / `:1256`).

Two easily missed but important details:

- **The subpixel phase is part of the cache key**: `gpui/text_system.rs:50` defines
  `SUBPIXEL_VARIANTS_X = 4`, `SUBPIXEL_VARIANTS_Y = 1`, i.e. at most four horizontal subpixel positions per
  glyph. Animated text usually moves on fractional x; without quantising the phase every frame would
  re-rasterize.
- **ClearType is simulated, not invoked**: real hardware ClearType requires **pixel-aligned text on an opaque
  background** and dies the moment a widget becomes transparent, scaled, or animated. GPUI instead takes the
  three-channel coverage from DirectWrite and applies gamma and enhanced-contrast correction in the fragment
  shader:

```hlsl
float3 alpha_corrected = apply_contrast_and_gamma_correction3(
    sample, input.color.rgb, subpixel_enhanced_contrast, gamma_ratios);
```

The parameters come from the system: `IDWriteRenderingParams1::GetGamma()` plus contrast values (see
`get_font_info`, around `directx_renderer.rs:353`), while `get_system_subpixel_rendering()`
(`direct_write.rs:1950`) reads the OS setting to decide whether subpixel is enabled at all.
**Conclusion: it looks like ClearType but remains ordinary alpha blending**, so transparent windows,
animation, and HiDPI scaling keep working. That is the same problem we hit with "ClearType cannot coexist with
a transparent background", solved differently.

Colour glyphs (emoji): `TranslateColorGlyphRun` (`direct_write.rs:1004`) requests only `COLR` layers, each
rasterized by `CreateAlphaTexture` into a one-channel bitmap, and then **composited on the GPU** by
`emoji_rasterization_fragment` (`color_text_raster.hlsl:39`) using each layer's `run_color`; **the RGBA
result is cached in the colour atlas** — the compositing happens once, not per draw.

### 5.3 Vectors: one pass for the whole batch, MSAA confined to that batch

`draw_paths_to_intermediate` (`directx_renderer.rs:615`):

1. Concatenate **every path vertex in the batch** into one array and draw it in one call into a **4×MSAA
   intermediate target** (`PATH_MULTISAMPLE_COUNT = 4`, `:26`; guaranteed by D3D11 feature level 10.1+);
2. The fragment shader computes coverage analytically instead of relying on MSAA samples (`shaders.hlsl:996`):
   ```hlsl
   float2 dx = ddx(input.st_position);
   float2 dy = ddy(input.st_position);
   float2 gradient = 2.0 * input.st_position.xx * float2(dx.x, dy.x) - float2(dx.y, dy.y);
   float distance  = (st.x*st.x - st.y) / length(gradient);   // analytic distance to the quadratic
   alpha = saturate(0.5 - distance);
   ```
   4× MSAA only guards the **triangle edges** here; curve interiors are handled by the expression above;
3. `ResolveSubresource` downsamples into a non-MSAA texture (around `:640`);
4. It is then blitted back to the main target as sprites (`draw_paths_from_intermediate`, `:678`) — per-path
   bounds when all paths share a draw order, otherwise one blit of the **minimal spanning rectangle** (so
   transparent paths are not copied twice).

Hence: **vectors only pay an extra render pass for the batch that contains paths, and MSAA memory exists only
there**. Icon-, border-, ring- and chart-heavy screens are not dragged down by MSAA, and there is no CPU-side
tessellation cache.

### 5.4 Corners / shadows: pure shader, no extra passes

- Corners: `quad_sdf()` evaluates a signed distance field in the colour fragment — **no mask, no render
  target**;
- Shadows (`shaders.hlsl:913`): when `blur_radius == 0` it degenerates to the SDF; otherwise it integrates a
  Gaussian with **four samples along y**, with `start/end` clamped to `±3σ` ("the signal is only non-zero in a
  limited range, so don't waste samples");
- `inset` shadows take the complement of the blurred hole and multiply by the element's own SDF edge.

So shadows and corners also cost one instanced quad — **no blur pass, no offscreen texture**.

---

## 6. Presentation and composition: the DirectComposition chain

Window creation (`window.rs:516`):

```rust
if !disable_direct_composition {
    dwexstyle |= WS_EX_NOREDIRECTIONBITMAP;   // no GDI redirection bitmap for this window
}
```

Swap chain (`directx_renderer.rs:1298`, `CreateSwapChainForComposition`):

| Parameter | Value | Why |
|---|---|---|
| `Format` | `B8G8R8A8_UNORM` | DComp/DWM's native format |
| `BufferCount` | **3** (`BUFFER_COUNT`, `:1695`) | With 2, the compositor can hold both back buffers while a window is being moved, stalling submission (we hit the same class of problem in `win32.md`) |
| `SwapEffect` | `FLIP_SEQUENTIAL` | The composition swap-chain take |
| `Scaling` | `DXGI_SCALING_STRETCH` | A comment states plainly that **composition swap chains accept only this value** (the HWND path uses `NONE`) |
| `AlphaMode` | `PREMULTIPLIED` | Blending is DWM's job, so it must be premultiplied |

The swap chain is then attached to a visual tree (`:1016-1031`):

```rust
let comp_device = DCompositionCreateDevice(&dxgi_device)?;
let comp_target  = comp_device.CreateTargetForHwnd(hwnd, true)?;
let comp_visual  = comp_device.CreateVisual()?;
comp_visual.SetContent(&swap_chain)?;
comp_target.SetRoot(&comp_visual)?;
comp_device.Commit()?;
```

The payoff: **frame alpha blending is done by DWM in premultiplied space**, so transparency, rounded/shadowed
edges, and HiDPI scaling are composited at the compositor's quality, and resizing does not produce the
GDI-era flicker or tearing. **This is also the correct answer for our own `<transparent>` on Windows** (see
§10).

For triage, the environment variable `GPUI_DISABLE_DIRECT_COMPOSITION` falls the whole chain back to
`CreateSwapChainForHwnd` (`Scaling = NONE`, `AlphaMode = IGNORE`, `SWAP_EFFECT_FLIP_SEQUENTIAL`).

---

## 7. Frame pacing: a `DwmFlush` thread plus a non-blocking Present

**What upstream does** (`vsync.rs` + `platform.rs:446`):

1. Start one process-wide thread named `VSyncProvider` (not one per window);
2. `VSyncProvider::new()` reads the real refresh period with `DwmGetCompositionTimingInfo`
   (`qpcRefreshPeriod`; impossible values such as 29 µs fall back to `rateRefresh`, then to 16.666 ms);
3. The loop **blocks in `DwmFlush()` until the DWM compositor clock**, then calls
   `RedrawWindow(..., RDW_INVALIDATE)` for **every visible, non-minimized** window; device-lost detection
   also happens on this thread;
4. The drawing side calls `Present(0, DXGI_PRESENT(0))` — **no wait flags at all**; Present never waits for
   vsync.

**A real trap, documented in a comment**: when the monitor sleeps or the window is fully occluded the
compositor has nothing to do, so `DwmFlush` returns **immediately**; without a check this degenerates into a
busy loop. The code uses a **1 ms threshold** to detect "waited too short", compensates with
`std::thread::sleep(interval)`, and tags the frame signal as `LocalSchedule` instead of `NativeCallback` — so
the layers above can tell that this frame did not come from the compositor.

**What "120 FPS" really means**: `gpui-kit/website/docs/fps.md:28` devotes a section to
"120 Hz is a frame budget, not a refresh promise" — it denotes a **budget** of 8.33 ms per frame on a 120 Hz
panel, not "rebuild the element tree 120 times a second while idle". Together with the `is_dirty` gate from §3,
an idle window **neither rebuilds nor presents**.

**Difference from our implementation**: our D3D12 backend calls `swapchain->Present(1, 0)`
(`vendor/d3d_glue.cc:1118`), i.e. **sync interval 1 = block inside Present until the next vblank**. The
consequence is that we tie the UI thread to vsync: a frame that overruns 16.67 ms gets no second chance, and
behaviour during drag/resize depends on SDL's pump cadence. GPUI's "dedicated DwmFlush thread +
non-blocking Present" separates **cadence** from **submission** — a different trade-off (tearing risk
absorbed by DWM compositing, plus a possible extra frame of latency).

---

## 8. Other engineering details

| Detail | Approach | Source |
|---|---|---|
| HLSL compilation | **release**: `build.rs` locates `fxc.exe`, compiles eight modules and embeds DXBC; **debug**: `D3DCompileFromFile` at runtime, so shaders can be edited live | `build.rs`, `directx_renderer.rs:1703/1842` |
| Device loss | `try_to_recover_from_device_lost`: **five retries** (from 100 ms, increasing); after recovery `skip_draws = true` **deliberately drops the first frame** — atlas tiles still reference textures owned by the old device, and drawing would panic | `directx_devices.rs:24-38`, `directx_renderer.rs:270/339` |
| GPU selection | Walk adapters and take the **first** one that can create a D3D11 device supporting `StructuredBuffer` (SM4.x `ComputeShaders_Plus_RawAndStructuredBuffers_Via_Shader_4_x`); **no WARP fallback**, and no `EnumAdapterByGpuPreference` | `directx_devices.rs:110-193` |
| Draw re-entrancy | `DrawCoordinator::try_begin_draw()`; a nested paint only `ValidateRect`s and sets `force_render_pending`, at most one frame late | `events.rs:55/1354` |
| Native surfaces | **Upstream `draw_surfaces` is a no-op** (`:816`) — WebView2-style native surfaces are simply not drawn by upstream's Windows backend | `directx_renderer.rs:816` |
| Background tasks | Thread-pool callbacks run at `THREAD_PRIORITY_TIME_CRITICAL` and raise timer resolution to 1 ms with `timeBeginPeriod(1)` while executing | `dispatcher.rs:155-171` |
| Input | Touch / precision touchpad go through an `IDirectManipulationManager` viewport (**gesture recognition only, no visual output**); events are drained at the top of `draw_window` | `direct_manipulation.rs`, `events.rs:1361` |
| System backdrop | `DWMWA_SYSTEMBACKDROP_TYPE` (22H2+), older systems fall back to `SetWindowCompositionAttribute` | `window.rs:1610-1651` |
| Debug annotation | `ID3DUserDefinedAnnotation::BeginEvent/EndEvent` labels batches for GPU debuggers (PIX) | `directx_renderer.rs:106-117` |

---

## 9. `gpui-fast`: retained views, scroll layers, and demand-driven Windows frames

> **This section is a rewrite.** The previous version read only the **packaged** `gpui-fast-windows 0.1.13`,
> which showed seven unrelated Windows optimisations. The fork's main branch
> (`asaotui/gpui-fast-src`, `046a859`) is a different order of thing: a **Retained Mode** (retained views +
> retained layout nodes) plus **scroll layers** (tile compositing), with the D3D11 work as the tail end.
> Everything below was re-checked against that source; the line-number convention is in the header.

### 9.1 How it coexists with upstream (this decides how much we can copy)

The fork holds itself to two rules (`README.md`): **the API does not change** (code written for upstream GPUI
compiles untouched), and **upstream files only gain hooks**. `script/check-upstream` enforces the second
mechanically: a hunk adding more than **8** lines, a file adding more than **40**, or added lines that do not
call into `fast/` all fail (exceptions are listed, each with its reason, in `script/upstream-allowlist`).
`docs/architecture.md` records 30 upstream files differing at the time of writing; the 20 in
`crates/gpui/src` differ by **+609 / −776 lines** — **more removed than added**, because several method bodies
were replaced by a one-line forward.

Where the code lives (**the previous version got this wrong**):

| Location | Contents | Size (measured here) |
|---|---|---|
| `crates/gpui/src/fast/` | all engine-side logic: retained subtrees, dependency recording, layout nodes, text carry, scroll layers, rounded clips, multi-surface composition | 25 modules in `mod.rs` + `tests/`; 73 files / **1.7 MB** |
| `crates/gpui_windows/src/fast/` | the Windows platform side: demand-driven frames, device recovery, bind dedup, cross-frame buffers, rounded masks, DComp composition | **14** files |
| other upstream files | a field, a one-line call, a forwarded method body | as above |

(The 0.1.13 package **copies** `src/fast/` into every crate; the main branch keeps one `fast/` per crate. So
the old sentence "the fork confines its own code to one submodule `src/fast/`" reads, on the main branch, as
"each crate has its own `fast/`".)

One judgement (still true, but it understated the scope): **upstream solves "what to draw" and "how to
batch"; fast solves "when to draw" and "whether a frame can do nothing at all".** Bind dedup is only the
smallest piece outside "do nothing".

### 9.2 Retained views: can a frame do nothing?

A frame walks the tree three times: `request_layout` (render views, ask for layout), `prepaint` (lay out and
place), `paint` (turn into the scene). Upstream does all three from scratch. fast treats **every view**
(`Entity<V: Render>` or `AnyView`, not only explicitly cached ones) as a retained subtree: while nothing it
depends on changed and it is drawn where it was, it is **not rendered, laid out, prepainted or painted** — its
primitives, hitboxes, listeners and dispatch nodes are copied from the last frame (`fast/retained.rs`, 83 KB;
"did it change?" lives in `fast/dependencies.rs`, 1326 lines).

The criterion is **recorded dependencies**, much wider than "who notified me":

| Dependency | How it is recorded |
|---|---|
| entities read | every access during render/layout/prepaint/paint, whether or not it was `observe`d |
| globals read | a generation stamp per global; merely asking whether one is set (`has_global`) depends on that alone, writing the value does not count |
| `ListState` / `ScrollHandle` | both carry versions, so moving them counts even when nobody notifies |
| window input state | reads of `mouse_position()` / `modifiers()` / `capslock()` are recorded the same way |
| where it is drawn | bounds, content mask, text style, hover/interaction state |

Two semantics are spelled out in the source: ① an **update without a notification** (as every `cx.subscribe`
handler does to its subscriber) counts as a change only for views drawn inside a view notified since the last
frame; ② state the application reads outside GPUI (`Rc<RefCell<..>>`, the clock, a cached
`window.modifiers()`) **must be followed by the application's own `cx.notify()`** — that is the one contract
gap in the mechanism, and it is stated in the README's "Using it" rather than hidden.

**Why not keep a persistent tree of view nodes** (`docs/architecture.md` §Why not a persistent tree): identity
already exists (`GlobalElementId` for element state, per-frame index ranges for reused output), and taffy is
already a persistent node store with a per-node layout cache. A second parallel tree would duplicate that
identity and force a restructure of the window drawing code, which is exactly the constraint the fork refuses
to break.

Runtime switch: `GPUI_VIEW_RETENTION=0` draws every frame from scratch, to rule retention in or out.

### 9.3 Retained layout nodes and text

- **Layout keys** (`fast/layout_key.rs`): a **path hash** from the root (`LAYOUT_ROOT_SEED` @`:61`), switching
to `ElementId` where an element moves among its siblings; `root_index` keeps window roots, prompts, drags and
tooltips in separate trees; prepaint adds its own salt (`:66`).
- **Did the style change**: a **64-bit fingerprint**. Release trusts it; debug **compares every field in
full** precisely to catch a field the fingerprint misses (`docs/architecture.md` §Costs). That is a useful
mirror for `PaintKit.measureField`: with 11 fields, compare them all; a fingerprint only pays once the style
grows, and it must keep a debug-mode full compare.
- **Text** (`fast/text.rs`): shaped line layouts are carried across frames (unchanged width reuses them); recent
glyphs are kept per generation (`RECENT_GLYPHS_PER_GENERATION` @`:808`).
- **Number shaping** (`fast/number_shaping.rs`): a number is its digits side by side, each digit's glyph and
advance adjusted by the kerning between neighbours, so per font+size the platform shapes single characters and
character pairs once and the rest is assembled in-process (character set is only `0123456789.,+-%$KMBT`).
The first **32** numbers and one in every **256** after that are shaped by the platform as well
(`CHECKED_FIRST` @`:37`, `CHECKED_EVERY` @`:38`); a font and size where the two disagree falls back to the
platform for good. **This speaks directly to our streaming numbers, which are new strings every frame.**
- **Path cache** `path_cache.rs`: 2048 entries / 16 MB (`:23`, `:29`). **Bounds grid** `bounds_tree.rs`: 64 px
cells (`:19`), at most 256 per axis. **Glyph origin quantisation** `glyphs.rs`: a whole-pixel scroll moves a
glyph by exactly that much.

### 9.4 Scroll layers: the case retained views cannot cover

A retained view replays only **where it was**. Once a container scrolls, every view inside it has moved, so
every one is rebuilt; in GPUI Kit's component gallery that was about **60 %** of a scrolled frame. Copying the
output elsewhere is not a fix: the output holds window coordinates everywhere (primitives, hitboxes, bounds
captured by listeners, element state), and whatever was outside the viewport last frame **was never painted**.

So it does what UIKit, Flutter and Chrome do (`fast/layers/`, 17 files, ~340 KB): the container's content is painted once
into a layer, rasterized into tiles, and a frame where only the offset changed composites the tiles at the new
offset. Each frame, each container takes one of three paths (`layers/policy.rs`):

| Path | When | What happens |
|---|---|---|
| **Composite** | only the offset changed and the viewport is still inside the painted region | content is not rendered/prepainted/painted; non-scene records are carried, hitboxes translated; the tiles over the viewport enter the scene as sprites |
| **Repaint** | the content changed, or the scroll reached the edge of the painted region | repaint into the layer's own scene over the viewport plus **2** viewports of overscan per scrolled side; **tiles are hashed and only changed ones re-rasterized** |
| **Bypass** | the layer cannot guarantee the result (see "the same pixels" below) | draw exactly as today |

Constants, all read from source: `TILE_SIZE = 512` (`layers/paint.rs:42`), `OVERSCAN_VIEWPORTS = 2`
(`paint.rs:862`), a **64 MB** tile budget (`policy.rs:55`), a layer only after **2** consecutive scrolled
frames (`PROMOTE_AFTER_SCROLLED_FRAMES` @`:40`), demotion when content changed on **≥8** of the last 16
frames (@`:43`), re-promotion after **60** stable frames (@`:46`), dropped after **120** frames without
compositing or on resize/scale (@`:53`).

The tile hash is the hinge of the design (`layers/tiles.rs`): it covers the primitives **that reach the
tile** (a shadow's blur and a transformed sprite included), in drawing order, moved into the tile's space;
content masks and layer bounds are hashed **clipped to the tile**, because hashed whole they move in content
space with the offset and would dirty every tile.

**The "same pixels" price list** (`docs/architecture.md` §The same pixels) — this is the real cost of adding
layers to an existing renderer:

- **Background**: subpixel text must know what it sits on, so a layer is used only when the viewport lies on
  one **opaque, solid-colour quad**, whose colour is baked into every tile; a gradient, a translucent window
  or a rounded corner inside the viewport means Bypass.
- **Pixel grid**: scroll offsets are snapped to device pixels (with or without layers), so both paths place
  content on the same grid.
- **Culling**: while a layer paints, the container culls against the **painted region**, not the viewport.
- **Paths never go into tiles**: a path's antialiasing depends on how pixels pair in 2×2 quads, so an odd
  pixel shift differs by one level; paths are drawn over the tiles when nothing covers them, else Bypass.

**The renderer contract** (`layers/scene.rs`, the only public extension): the core hands renderers two things —
① each visible tile is an **ordinary polychrome sprite** whose texture id lies in a range no atlas allocates
(`LAYER_TILE_TEXTURE_BASE = 0xF000_0000` @`:26`), so ordering, clipping and batching stay the scene's job;
② `Scene.layers` with each layer's content scene, generation and dirty tiles. The renderer keeps tile textures,
re-rasterizes the dirty ones (`LayerFrame::tile_scene`), binds a tile's texture when it meets its sprite, and
**nothing flows back to the core**. `COMPILED` (`layers/mod.rs:32`) is true only on Linux (wgpu), macOS
(Metal) and Windows (D3D11).

### 9.5 The Windows side: `crates/gpui_windows/src/fast/`

| File | What it does | The point |
|---|---|---|
| `frame_schedule.rs` (323 lines) | **demand-driven frames** | `FrameRequest{pending: AtomicBool}` + `FrameWake{mutex, condvar}`; `take_request()` decides whether this window draws this frame; the worker thread rides `DwmFlush` and **redraws only the windows that asked** |
| `device_wake.rs` (93 lines) | waits for device removal without polling | `RegisterWaitForSingleObject` on the D3D11 removal event wakes the scheduler through a condvar |
| `device_recovery.rs` (164 lines) | the two field crashes | upstream treats any failed resize as a lost device and panics when the rebuild fails again. fast splits them: `E_OUTOFMEMORY` ⇒ **retry the resize next frame** (the device is fine); `DXGI_ERROR_DEVICE_RESET` ⇒ ask the platform for **new** devices, at most **5** times (`MAX_FAILED_RECOVERIES` @`:23`); with no devices it **skips drawing** instead of unwrapping |
| `draw_state.rs` (131 lines) | bind dedup | remembers shader/blend/topology/SRV/sampler/constant buffer and binds only changes; **`forget()` at the start of every frame**, because DirectWrite rasterization sets its own state on the same context |
| `frame.rs` (442 lines) | cross-frame buffers | path vertices and sprites live in `FrameState` (alongside globals, the `TileCache` and `rounded_masks`); with a graphics debugger attached it still runs upstream's loop, keeping each batch's label |
| `rounded_clip.rs` (272 lines) | mask-free rounded scopes | the curved padding-edge geometry goes into an `D3D11_USAGE_IMMUTABLE` `R32G32B32A32_FLOAT` texture and is evaluated in the colour shader; **no mask render target and no extra pass** |
| `composition.rs` (24 KB) + engine `fast/composition.rs` (2379 lines) | multiple surfaces | a window can present several ordered surfaces, with a native view (WebView2 / WKWebView / subsurface) between GPUI's base and overlay; on D3D11 each surface gets its own swap chain and visual under the DComp root. Two surfaces by default (`DEFAULT_SURFACES = 2` @`:760`) and opt-in via `enable_window_composition` |
| `native_tests.rs` (20 KB) | real-window regression | one case per process (`GPUI_NATIVE_CASE=paint_race\|input_restore\|recovery`, `GPUI_NATIVE_DCOMP=0\|1`), asserted with `SendInput` and `GetUpdateRect`; recovery also needs an explicit `GPUI_TEST_ALLOW_GPU_RESET=1` |

The renderer itself (upstream file, logic unchanged) can be checked: `BUFFER_COUNT = 3`
(`directx_renderer.rs:1713`), `CreateSwapChainForComposition` with `FLIP_SEQUENTIAL` (`:1339`/`:1335`),
`Present(0, DXGI_PRESENT(0))` (`:258`, **non-blocking**), `WS_EX_NOREDIRECTIONBITMAP` (`window.rs:520`), and
the vsync thread's `DwmFlush()` (`vsync.rs:37`).

### 9.6 How correctness is proven (the most copyable part)

Retained UI fails by "one dependency was not recorded, so something that should have been rebuilt was not",
which point tests cannot catch. The answer is **two arms driven through the same random history**:

- **The oracle** (`fast/tests/oracle.rs`, 1070 lines): two windows run the same random history of changes, one
  incremental and one that **forgets everything before every frame**. Every frame the **complete scene** must
  match (quads, shadows, underlines, monochrome/subpixel/polychrome sprites, paths; every hitbox's bounds,
  content mask and behaviour). It also asserts the incremental window **actually reused** layout nodes and
  subtrees, so it cannot pass by never retaining.
- **The layer oracle** (`fast/tests/layers_oracle.rs`): random wheel scrolls (fractional deltas and fractional
  scales included), programmatic scrolls, hovers, clicks, key presses and content changes; every frame it
  compares the scenes with each layer's tiles **expanded into primitives** against the arm without layers, plus
  hit tests at random points and the positions listeners observed.
- **Renderer pixel tests**: tile rasterization/compositing compared byte for byte with the same content drawn
  directly, on a real device, per platform in CI.
- **`gpui_perf --headless --verify`**: the same scenario run in lockstep with retention on and off, comparing
  quads, text, icons, images and underlines each frame (paths and shadows are the oracle's job).
- Runtime switches: `GPUI_VIEW_RETENTION=0`, `GPUI_SCROLL_LAYERS=0`.

What this proves is "for these sequences of state changes, the retained output equals the from-scratch
output". It cannot prove anything about state an application reads outside GPUI, which the README says
outright. That boundary is drawn cleanly enough to copy into our own gate design.

### 9.7 Numbers, costs, and two places where their docs lag the code

**Retained views** (Linux release, headless, `retained_bench`, 60 panels × 64 labels each):

| Panels notified per frame | From scratch | Retained | Source |
|---|---|---|---|
| 0 | 10.43 ms | **0.25 ms** (−98%) | `README.md` |
| 1 | 11.58 ms | 1.35 ms (−88%) | `README.md` |
| 6 | 13.06 ms | 3.86 ms (−70%) | `README.md` |
| 60 (all) | 18.25 ms | 14.57 ms (−20%) | `README.md` |

`docs/architecture.md` §Results has **another set of absolute numbers for the same experiment**
(3.31→0.19, 6.72→0.71, 7.27→1.46, 10.33→7.38 ms): identical percentages, different magnitude — clearly two
runs on different machines or days. **Quote them with their source and never splice the two into one table.**

**Scroll layers** (`gpui_perf --headless`, real wheel events, retained views on in both columns): a page of 24
sections of buttons 0.618 → **0.068 ms** (−89 %); the same page drawn by the scrolling view itself 0.599 →
0.226 ms (−62 %). GPUI Kit's component gallery scrolling the Button story at 145 Hz: 27–28 % of a core with
retained views alone, **18–20 %** with scroll layers (1.53–1.63 ms → 0.92–1.02 ms per frame).

**Costs (quote them together with the gains)**: hooks cost +**0.85 %** instructions on average (+2.7 % worst
case); a frame that repaints a layer paints **5 viewports** of content (5–6.5 ms against 0.6 ms without
layers), once per two viewports scrolled; tiles are capped at 64 MB; every retained subtree keeps a record per
frame and taffy keeps its nodes.

**Two inconsistencies (measured here, recorded as found):**

1. `crates/gpui/src/fast/layers/lists.rs:78` is `LIST_LAYERS = true`, while `docs/architecture.md` §Lists still
   says list layers are off. **The code wins**: list layers are on (per-row records, overscan, hover decided
   during prepaint so only rows whose hover changed are rebuilt). Which is a reminder for us: their own docs
   drift, so `grep` the code before quoting a switch or a number.
2. The two tables above disagree on absolute values (see above).

---

## 10. Trade-offs for us (Win32 + SDL2 + Skia D3D12)

Current state is in [`win32.md`](win32.md): `CreateSwapChainForHwnd` (`FLIP_DISCARD` + `R8G8B8A8_UNORM` +
`Scaling = NONE`) → `SkSurfaces::WrapBackendRenderTarget` → Ganesh D3D12 → `Present(1, 0)`.

| Verdict | Item | Reasoning |
|---|---|---|
| **Adopt** | The **DirectComposition** chain: `WS_EX_NOREDIRECTIONBITMAP` + `CreateSwapChainForComposition` (`PREMULTIPLIED`) + a visual at the root | It closes the gap recorded in row 24 of the `win32.md` checklist: **`<transparent>` is unimplemented on Windows**. The old idea (`WS_EX_LAYERED` + per-frame `UpdateLayeredWindow` alpha) needs a CPU readback or an extra D3D target, whereas DComp lets DWM composite on the GPU and additionally handles rounded windows (`DWMWA_WINDOW_CORNER_PREFERENCE`) and shadow edges. **This is the single most valuable item in this document for us** |
| **Adopt (evaluate)** | Present decoupling: dedicated `DwmFlush` thread + `Present(0,0)` | Our `Present(1,0)` pins the UI thread to vblank; during drag/resize, `win32.md` §2.8 already shows frames can only be driven by the SDL event watch. Whether decoupling improves frame-time distribution needs measurement (the `ASC_GPU_STATS=1` instrumentation exists). Risks are tearing and one frame of latency, and AIR's `frameRate` semantics describe the **application's own cadence**, which need not be locked to the compositor — confirm `adl` behaviour before touching it |
| **Adopt (cheap)** | Three back buffers | `win32.md` already records that `BufferCount=2` lets the compositor hold both buffers while moving a window, stalling submission. GPUI uses three |
| **Adopt (new, cheapest of all)** | **An oracle-style regression**: run the same input through two arms (retained / forced to forget everything every frame), compare the complete result frame by frame, and assert that the retained arm **actually reused** | Our 37 CheckUi checks are **point tests**: they can only prove the path I thought of. The failure mode of retained UI is "a dependency was not recorded, so something that should have been rebuilt was not", which only a random history catches (§9.6). Concretely for asaotui: run one description tree through reconcile twice (once forced to rebuild everything) and compare the UiNode tree, rects and paint order; the retained arm must also assert it did not rebuild, or it passes by never retaining. `probes/frame` plus one env switch is enough |
| **Adopt (perf, kit side, quantifiable today)** | **Retained layout**: every layout node keeps its own cache (style fingerprint + child sizes + available size), so only the dirty path and its ancestors are re-solved. Our own `seam/asaot/ui/as3/As3LayoutEngine.as:449-450` states that the subset recomputes on every calculate, so dirty tracking is a no-op — `grep -n "recomputes on every calculate"` confirms it on the spot | Measured `text:1000` (one row of 1000 changes): solve **1.29 ms/frame**, of which 999 rows should not be re-solved at all; taffy per-node cache is exactly what removes it. `idle` is 17 ms, the vsync floor, so this 1.29 ms is a **pure increment on top of the floor** |
| **Adopt (perf, kit side, largest single item)** | **Retained views**: if the dependencies it read are unchanged and it paints in the same place, skip render / prepaint / paint for the whole subtree. What we lack is the **source** of which rows did not change — it gets that from entity read-tracking, whereas we would have to have widgets declare dependency keys (ListState version, selection, hover) | Measured `text:1000`: render 0.66 + reconcile **2.50** = **3.16 ms/frame** spent on 999 unchanged rows; that is where its -98% comes from. **Take the cost with it**: its own all-changed case only reaches -20% (10.33 -> 7.38 ms), so do not expect this to fix the 51 ms of `all:1000` |
| **Adopt (compiler side, highest value)** | Point the same oracle at **incremental auto-bake**: one arm patches, the other rebuilds fully every frame, over the same random mutation history, compared pixel for pixel — plus an assertion that the patching arm really patched | The real-app logs (335 s: `bake_patch=0` / `bake_rebuild=5263`; 180 s re-collection: `patch=0` / `rebuild=52`, with 125 s of silence in between) show this, but `bake_patch=0` is **structural**, not merely unreached: an auto-bake boundary drops `_cache_surface` and falls back to live painting, and only an explicit `cacheAsBitmap` (`_cache_flag`) keeps the surface long enough to patch (`repaint-boundary.md` §5, stages B/C). So this oracle presupposes "let auto-bake keep its surface too" (a stage-381 candidate). Without that gate, one missing dependency means silent visual corruption |
| **Already present (was written as a gap; corrected 2026-11-07 after a line-by-line check)** | Three and a half of `device_recovery`'s four rules are already ours: ① `E_OUTOFMEMORY` is not treated as a lost device — the comment at `vendor/d3d_glue.cc:591-600` and the `d3d_hr_is_device_lost()` branch at `:882-899` rebuild only **this window's** swapchain and retry on a 250 ms throttle (`ASC_GPU_RESIZE_FAIL=1` injects it, `:878`); ② frames are skipped while lost — after `d3d_mark_lost()` `sk_gpu_begin_frame` returns `nullptr` (`:833`); ③ no device means backoff, not a panic — 250→4000 ms exponential (`:661`); ④ three back buffers — `SK_D3D_NUM_FRAMES 3` (`:174`) | The one real difference is its hard cap of 5 rebuilds; we back off indefinitely and never panic, which is **safer, so there is nothing to change**. The row used to say we know "only `DXGI_ERROR_DEVICE_RESET`" — that mistook `win32.md` §3.13 for a complete list; the code has split the two cases for a while |
| **Adopt (evaluate, most expensive)** | **Scroll layers** (tiles + three paths + the renderer contract) | The real answer to "list scrolling drops frames" **in the renderer**, but it is not "add a cache": solid background, paths excluded from tiles, offsets snapped to device pixels, culling against the painted region — four renderer contracts (§9.4). The kit side is already down to 1.0 ms of fixed cost per frame (`asaotui/STATUS.md` §3.21), so **what is left is the large-area repaint itself**, which is exactly this; but the landing zone is the `as3compiler` renderer (L1), not the kit |
| **Note it (usable as-is)** | `number_shaping.rs`: a number = per-character glyph/advance plus neighbour-pair kerning, assembled in-process, with the first 32 and every 256th checked by the platform | Our streaming numbers (prices, countdowns, gift counters) are new strings every frame, so they are reshaped every frame. We have no ligatures to worry about, but **the platform cross-check cannot be skipped**, or kerning drift goes wrong silently |
| **Note it** | Demand-driven frames: our equivalent is the `wantsPaint` gate plus the static-window skip of raster/Present; what it adds is "the UI thread sleeps entirely (`FrameRequest` + condvar) and wakes only when a frame is wanted" | Same direction, and neither lowers the logical frame rate. Theirs takes an idle window to near-zero CPU; our pixel comparison has to run the check first. Moving our gate down into the driver layer would need measurement of idle-frame CPU and `ASC_FRAME_STATS` p99 before it is worth anything |
| **Do not adopt** | Bind dedup, the way `DrawState` does it | We never descend to the D3D11 binding layer; Skia's Ganesh owns that state and already merges adjacent batches with the same state. This only pays for someone with a hand-written primitive pipeline |
| **Do not adopt** | The hand-written primitive pipeline (eight primitive kinds, instance buffers, structured buffers, custom AA) | Ganesh inside Skia already does batch merging, glyph atlases, analytic AA and SDF. Re-implementing would mean dismantling Skia. GPUI builds its own because it **carries no general-purpose 2D API obligation** and can afford exactly eight primitives |
| **Do not adopt** | DirectWrite glyph rasterization **implementation detail** | Our text stack is already delegated to Skia (including glyph cache and atlas); a second implementation only buys a second calibration baseline. But two of its **constraints** are worth remembering: ① glyph bitmaps must be split into per-format atlases (grayscale vs 3×1 vs RGBA); ② the subpixel phase must be part of the cache key |
| **Do not adopt** | Its GPU adapter selection policy | "Take the first usable adapter, no WARP fallback" lands on the iGPU on hybrid laptops; our enumerate-then-probe-with-`D3D12CreateDevice` selection in `win32.md` is more robust |
| **Note it** | The ClearType simulation route | If we ever want subpixel text on transparent or animated surfaces, the correct shape is "coverage bitmap + gamma/contrast correction in the shader", not calling the OS ClearType path |

---

## 11. How to re-check

Every claim in §9 can be checked **on this machine right now** (the source is in this workspace; no Rust build
needed):

```sh
cd asaotui/gpui-fast-src        # 046a859; clone command in the header

# -- engine side: retention, scroll layers, text --
grep -n 'pub(crate) const COMPILED'      crates/gpui/src/fast/layers/mod.rs            # expected :32, linux/macos/windows only
grep -n 'TILE_SIZE: u32\|OVERSCAN_VIEWPORTS' crates/gpui/src/fast/layers/paint.rs      # expected 512 / 2.
grep -n 'TILE_BUDGET_BYTES\|PROMOTE_AFTER\|DEMOTE_AFTER\|DROP_AFTER' crates/gpui/src/fast/layers/policy.rs
grep -n 'LAYER_TILE_TEXTURE_BASE'        crates/gpui/src/fast/layers/scene.rs            # expected 0xF000_0000
grep -n 'const LIST_LAYERS'              crates/gpui/src/fast/layers/lists.rs            # expected true (its architecture.md still says off)
grep -n 'CHECKED_FIRST\|CHECKED_EVERY'    crates/gpui/src/fast/number_shaping.rs         # expected 32 / 256
grep -n 'KEPT_BYTES'                     crates/gpui/src/fast/path_cache.rs              # expected 16 MiB

# -- Windows side --
grep -n 'take_request'                   crates/gpui_windows/src/fast/frame_schedule.rs
grep -n 'MAX_FAILED_RECOVERIES'           crates/gpui_windows/src/fast/device_recovery.rs  # expected 5
grep -n 'D3D11_USAGE_IMMUTABLE'           crates/gpui_windows/src/fast/rounded_clip.rs
grep -n 'BUFFER_COUNT'                   crates/gpui_windows/src/directx_renderer.rs     # expected 3 (:1713)
grep -n 'Present(0'                      crates/gpui_windows/src/directx_renderer.rs     # expected :258
grep -n 'NOREDIRECTIONBITMAP'             crates/gpui_windows/src/window.rs               # expected :520
grep -rn 'D2D\|Direct2D'                 crates/gpui_windows/src                          # expected: no hits
```

**The §2–§8 line numbers cannot be checked right now** (the `0.1.13` / `0.3.11` snapshots are no longer in the
workspace): the conclusions stand, but checking them line by line means unpacking the snapshot again with the
first command in the header.

To check the "retained equals from-scratch" guarantee, no window is needed: `cargo test -p gpui
fast::tests::oracle` (needs a Rust toolchain, which **we have not run** — every number in this document is
taken from their `README.md` / `docs/architecture.md`, with the source marked; none of it is our own
measurement).

To observe behaviour on real hardware, the two smallest probes remain: the difference in window transparency
and resizing with and without `GPUI_DISABLE_DIRECT_COMPOSITION=1`; and a single PIX capture to inspect
batching (`ID3DUserDefinedAnnotation` labels appear as one event per batch). Three runtime switches are worth
knowing first: `GPUI_VIEW_RETENTION=0`, `GPUI_SCROLL_LAYERS=0`, `GPUI_NATIVE_CASE=paint_race|input_restore|recovery`.
