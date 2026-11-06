# The GPUI (Zed) Windows Backend: How It Draws UI and How It Accelerates

> **Status: research only. No code changed, no version bump.** This document answers one question: *what does
> a production Rust GUI framework draw with on Windows, and why is it fast?* It is a reference for our own
> Windows backend (Win32 + SDL2 + Skia D3D12, see [`win32.md`](win32.md)); it does **not** argue for
> copying GPUI — see §10 for why.
>
> **Subjects (two crates, not one repository)**:
> - `gpui-pre-windows 0.3.11` — Zed's `crates/gpui_windows` snapshot, metadata records `zed@f816e1f`.
>   This is the **primary evidence source**.
> - `gpui-fast-windows 0.1.13` — longbridge's `gpui-fast` fork of Zed's GPUI; the Windows additions are in §9.
>   **Every behavioural difference from upstream is marked.**
>
> How the sources were obtained (unpacked under `temp/gpui/`, a scratch directory that is not committed):
>
> ```sh
> git clone --depth 1 https://github.com/longbridge/gpui-kit.git temp/gpui/gpui-kit
> curl -sL -o gpui-pre-windows.crate \
>   https://crates.io/api/v1/crates/gpui-pre-windows/0.3.11/download   # plus three other crates
> ```
>
> **Line-number convention**: every `file:line` below is relative to
> `gpui-pre-windows-0.3.11/src/` unless it carries a `gpui/` prefix, which means the upstream core crate
> `gpui-pre-0.3.11/src/`. The line numbers are valid only for that snapshot — it is pinned
> (`Cargo.toml` requires the exact `=0.3.11`, see the comment in `gpui-kit/Cargo.toml`), so they can be
> re-checked.
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

## 9. The `gpui-fast` fork: a second acceleration layer

longbridge's fork confines its own code to one submodule (`src/fast/`) and adds only "one forwarding line" to
upstream files so that upstream merges stay cheap. Windows-specific additions (**unrelated to D2D, and
unrelated to the platform — mac/Linux/web have counterparts**):

| Optimisation | Upstream behaviour | fast behaviour | Source |
|---|---|---|---|
| **Demand-driven frames** | Every vsync **unconditionally** invalidates all visible windows, so the UI thread must wake and traverse `WndProc` | A `FrameRequest` latch: no request, no invalidation, no UI-thread wake | `fast/frame_schedule.rs:118` |
| **Bind deduplication** | Each batch re-binds pipeline/sampler/texture/constant buffer from scratch | `DrawState` remembers current bindings and skips repeats | `fast/draw_state.rs` |
| **Reused path buffers** | Each batch allocates new `Vec`s for vertices and sprites | Vertex/sprite buffers persist across frames | `fast/frame.rs` |
| **Scroll-layer tile cache** | Scrolling repaints the whole layer | Tiles are cached and only changed tiles recomposited | `fast/layers/` |
| **Mask-free rounded scopes** | — | Corner geometry is written into one **immutable** texture and evaluated in the colour shader; no mask render target | `fast/rounded_clip.rs` |
| **Multi-surface composition** | One swap chain and one visual per window | Every GPUI surface (including WebView2 native surfaces) gets its own swap chain and visual, ordered under the DComp tree root; native surfaces use a rectangular clip plus opacity to hide | `fast/composition.rs` |
| **Threaded submission** | The vsync thread only invalidates | Promoted to a worker with device recovery; frame requests wake it via a condvar | `fast/frame_schedule.rs` |

The fork also accelerates the **engine** (retained scene, incremental layout, `layout_key`, `path_cache`,
`line_break`, … under `gpui-fast/src/fast/`), which is orthogonal to the platform backend.

One judgement: **upstream has already solved "what to draw" and "how to batch"; fast solves "when to draw" and
"redundant binding"**. The latter is relevant to us — does our `sk_pump_frame` re-set pipeline state on every
frame? Worth one measurement.

---

## 10. Trade-offs for us (Win32 + SDL2 + Skia D3D12)

Current state is in [`win32.md`](win32.md): `CreateSwapChainForHwnd` (`FLIP_DISCARD` + `R8G8B8A8_UNORM` +
`Scaling = NONE`) → `SkSurfaces::WrapBackendRenderTarget` → Ganesh D3D12 → `Present(1, 0)`.

| Verdict | Item | Reasoning |
|---|---|---|
| **Adopt** | The **DirectComposition** chain: `WS_EX_NOREDIRECTIONBITMAP` + `CreateSwapChainForComposition` (`PREMULTIPLIED`) + a visual at the root | It closes the gap recorded in row 24 of the `win32.md` checklist: **`<transparent>` is unimplemented on Windows**. The old idea (`WS_EX_LAYERED` + per-frame `UpdateLayeredWindow` alpha) needs a CPU readback or an extra D3D target, whereas DComp lets DWM composite on the GPU and additionally handles rounded windows (`DWMWA_WINDOW_CORNER_PREFERENCE`) and shadow edges. **This is the single most valuable item in this document for us** |
| **Adopt (evaluate)** | Present decoupling: dedicated `DwmFlush` thread + `Present(0,0)` | Our `Present(1,0)` pins the UI thread to vblank; during drag/resize, `win32.md` §2.8 already shows frames can only be driven by the SDL event watch. Whether decoupling improves frame-time distribution needs measurement (the `ASC_GPU_STATS=1` instrumentation exists). Risks are tearing and one frame of latency, and AIR's `frameRate` semantics describe the **application's own cadence**, which need not be locked to the compositor — confirm `adl` behaviour before touching it |
| **Adopt (cheap)** | Three back buffers | `win32.md` already records that `BufferCount=2` lets the compositor hold both buffers while moving a window, stalling submission. GPUI uses three |
| **Do not adopt** | The hand-written primitive pipeline (eight primitive kinds, instance buffers, structured buffers, custom AA) | Ganesh inside Skia already does batch merging, glyph atlases, analytic AA and SDF. Re-implementing would mean dismantling Skia. GPUI builds its own because it **carries no general-purpose 2D API obligation** and can afford exactly eight primitives |
| **Do not adopt** | DirectWrite glyph rasterization **implementation detail** | Our text stack is already delegated to Skia (including glyph cache and atlas); a second implementation only buys a second calibration baseline. But two of its **constraints** are worth remembering: ① glyph bitmaps must be split into per-format atlases (grayscale vs 3×1 vs RGBA); ② the subpixel phase must be part of the cache key |
| **Do not adopt** | Its GPU adapter selection policy | "Take the first usable adapter, no WARP fallback" lands on the iGPU on hybrid laptops; our enumerate-then-probe-with-`D3D12CreateDevice` selection in `win32.md` is more robust |
| **Note it** | The ClearType simulation route | If we ever want subpixel text on transparent or animated surfaces, the correct shape is "coverage bitmap + gamma/contrast correction in the shader", not calling the OS ClearType path |

---

## 11. How to re-check

No Zed build is needed to verify any claim here (that would require Windows + MSVC + the full Cargo graph);
reading the sources is enough:

```sh
cd temp/gpui/crates/gpui-pre-windows-0.3.11/src

grep -rn 'D2D\|Direct2D' .                 # expected: no hits
grep -n 'CreateSwapChainFor' directx_renderer.rs
grep -n 'DrawInstanced' directx_renderer.rs      # expected: two sites, both (4, N)
grep -n 'Present(' directx_renderer.rs           # expected: Present(0, DXGI_PRESENT(0))
grep -n 'CreateAlphaTexture\|CreateGlyphRunAnalysis' direct_write.rs
grep -n 'SUBPIXEL_VARIANTS' ../../gpui-pre-0.3.11/src/text_system.rs
grep -n 'RDW_INVALIDATE' platform.rs      # unconditional invalidation every vsync (upstream)
grep -n 'take_request' ../gpui-fast-windows-0.1.13/src/fast/frame_schedule.rs   # fast's latch
```

To observe the behaviour on real hardware, the two smallest probes are: the difference in window transparency
and resizing with and without `GPUI_DISABLE_DIRECT_COMPOSITION=1`; and a single PIX capture to inspect
batching (`ID3DUserDefinedAnnotation` labels appear as one event per batch).
