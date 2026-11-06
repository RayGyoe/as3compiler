# RepaintBoundary Dirty-Layer Repaint — Design Document (Implementation Plan)

> Status: **design only, not implemented**. This is the build blueprint for a later stage, not shipped behavior.
>
> In one sentence: upgrade render invalidation from "full-tree fingerprint probing every frame" to
> "**write-time dirty marking + boundary isolation + repaint only dirty layers**", aligning `cacheAsBitmap`
> with AIR's write-time invalidation semantics and moving toward Flutter's `RepaintBoundary`.
>
> Full measurements for the motivation and the existing auto-bake machinery live in [`skia.md`](skia.md)
> §6.10–§6.14 and [`gc.md`](gc.md) §6. This document covers only the dirty-layer-repaint line.

---

## 1. Background and motivation

### 1.1 Current state: full redraw every frame + passive auto-bake

Rendering today is **retained-semantics, full-every-frame**:

1. **Window-level dirty detection** (exists): `ASC_window_render(id)` first fingerprints the whole Stage
   (`render_fp`); if unchanged it skips swapchain acquire + clear + `Present` (`ASCWin.render_fp` in
   `src/emit.ts`). This is **whole-frame** granularity, not subtree.
2. **Subtree-level passive baking** (exists): `as_render_fp(o)` recursively fingerprints the whole tree every
   frame; when an object's fingerprint is unchanged for `ASC_AUTO_BAKE_FRAMES` (=3) frames and it is not a
   single-primitive node (`!as_single_primitive`), it sets `_auto_baked=1` and bakes the subtree into an
   `SkImage` (`_cache_image`); `as_render_object` then goes through `as_render_cached` and only blits the
   snapshot. Explicit `cacheAsBitmap` (`_cache_flag`) uses the same bake path.
3. **No active invalidation**: when the fingerprint changes, `_auto_baked=0`, `_cache_valid=0`, the object drops
   its bake → redraws the whole subtree live for N frames → sits still for N frames → re-bakes.

### 1.2 Performance gap (measured, not guessed)

- `skia.md` §6.14: after optimization the panel scene still costs **2.56 µs/item** vs AIR **1.85 µs/item**;
  `panel_192` **1.331 ms/frame**. The crossover moved from ≈46 items to >1100, but high-object-count scenes
  (hundreds of list rows) still lose.
- `TODO.md` stage forty-seven: the FPS scene rasterizes 2000×1360 on the CPU every frame + SDL blit, while AIR
  uses GPU compositing + **dirty rectangles** (only redraws a 90×20 TextField region).
- Two intrinsic costs of passive probing:
  - **O(tree) fingerprint every frame**: `as_render_fp` recursively hashes every render input (transform,
    graphics, text, filters, children…) whether or not anything changed.
  - **Invalidation latency**: sit still 3 frames to bake, then idle 3 frames live before re-baking. hover /
    scroll / edit — "change once then go quiet" interactions — oscillate exactly between bake and drop, which
    is where the "jitter" and "clear then blurry" artifacts in §6.12/§6.14 come from.

### 1.3 The Flutter comparison

Flutter's `RepaintBoundary` is fast not because its backend (also Skia/Impeller) beats ours, but because it
builds **retained mode + dirty marking + layer compositing** on top of rasterization: `markNeedsPaint` bubbles
"who is dirty" up to the nearest `RepaintBoundary`, and each frame **repaints only that one dirty layer** —
sibling, parent and background layers don't move. What we need to add is exactly this "write-time invalidation +
repaint only dirty layers", not a new backend.

---

## 2. Goals and non-goals

### 2.1 Goals

1. **Write-time dirty marking**: every write to a render input (`x`/`text`/`graphics`/`addChild`/…) marks dirty
   and bubbles up, replacing the read path of "full-tree fingerprint every frame".
2. **Boundary isolation**: establish `cacheAsBitmap` as the explicit repaint boundary (it already is
   "bake subtree into a standalone bitmap, parent only blits"), and let the automatic boundary (auto-bake)
   inherit the same invalidation semantics.
3. **Repaint only dirty layers**: each frame only dirty boundary layers re-rasterize, other layers reuse the
   previous snapshot; inside a boundary (stage C) repaint only the dirty region/subtree.

### 2.2 Non-goals

- **Do not change AIR-defined behavior**: the AS3 semantics of `cacheAsBitmap` (`getCacheAsBitmap`, implicit
  enable under filters, `cacheAsBitmapMatrix`) stay verbatim. This design only aligns the **invalidation
  timing** with AIR (§4.1); it adds/rewrites no AIR semantics.
- **No third-party dependencies** (§3.1 rule): dirty marking is runtime C structs + emitter injection; no
  library beyond Skia is touched.
- **No full DisplayList recording in the first version**: Flutter's `DisplayList` (record + replay) is a larger
  project, listed as stage D (optional), outside the A–C acceptance scope.
- **No generational GC**: the per-frame `gc_step()` budget and write-barrier overhead are a separate line
  (`gc.md` §6), out of scope here.

---

## 3. Current-state inventory

| Capability | State | Location |
|---|---|---|
| Window-level dirty detection (skip Present when unchanged) | ✅ | `ASC_window_render` / `ASCWin.render_fp` |
| Subtree-level passive bake (auto-bake) | ✅ | `as_render_fp` → `_auto_baked`, `as_render_cached` |
| Explicit bake (cacheAsBitmap) | ✅ | `_cache_flag` → same `as_render_cached` |
| Snapshot bitmap + device-grid snapping + phase | ✅ | `_cache_image` / `_cache_phx` / `_cache_phy` / §6.12 |
| Single-primitive alpha folding / single-primitive bake refusal | ✅ | `as_single_primitive` / `as_draw_count` |
| **Write-time dirty marking + upward propagation** | ❌ | none |
| **Intra-boundary local repaint (dirty rect/subtree)** | ❌ | none (`emit.ts:40320` explicitly "no AIR-style region list") |
| Render-input enumeration | ✅ (as fingerprint) | `as_render_fp` hashed-field list |

**Key observation**: `as_render_fp` is already the enumeration of "the full set of render inputs" — it hashes
`x/y/rotation/scale*/alpha/visible/blendMode/mask/scrollRect/transform/filters/graphics/bitmapData/text/…`
every one of them. That list **is** the ready-made source of "the write points that need dirty marking": turning
it from "hash on read" to "set on write" is the entire core of stage B. This sharply lowers the risk of missing a
write point — a fingerprint input that was missed already froze the bake (many measured lessons in the docs), so
the list has been patched complete through repeated bugs.

---

## 4. Core design

### 4.1 API shape: why reuse `cacheAsBitmap`

AIR has **no** `RepaintBoundary` concept. AIR's counterparts are a triad:

1. `cacheAsBitmap`: bake the subtree into a bitmap, **regenerate** when the object or its children change;
2. `scrollRect`: the scroll window;
3. the GPU hardware compositor: composite those bitmaps by transform and use **dirty rectangles** to redraw only
   invalidated regions.

`cacheAsBitmap` semantically **is already a repaint boundary** — it isolates the subtree from the parent into two
layers. And AIR's invalidation is **write-time**: `skia.md` §6.10 already measured "AIR's cache is not a snapshot:
the player regenerates the bitmap when the object or its children change". In other words, **the correct
AIR-aligned implementation should already be write-time invalidation + regenerate-on-change, not our current
read-time fingerprint probing + sit-still-3-frames-then-bake**.

Conclusion:

- **Primary**: `cacheAsBitmap` = explicit RepaintBoundary. No new AS3 API; semantics stay AIR-aligned; only the
  invalidation model upgrades from "fingerprint probing" to "write-time dirty marking". This is **fixing the
  implementation, not an enhancement** — AIR's cacheAsBitmap invalidation is write-time by definition.
- **Secondary**: auto-bake as an "automatic boundary", reusing the same dirty marking (upgrading auto-bake from
  "sit-still probing" to "write-time invalidation").
- **Optional enhancement** (genuinely beyond AIR, must be opt-in): a new `flash.display.RepaintBoundary`
  container class, or manifest `repaint-boundaries` auto-insertion. **Off by default**, AIR-isomorphic. Deferred
  as an independent enhancement after stage C; this document only sketches the interface shape, no first-version
  commitment.

### 4.2 Data structures

Add to the `DisplayObject` struct (beside the existing `_cache_*` fields in `src/emit.ts`):

```c
int   _render_dirty;     // self-or-subtree invalidated since last render
// stage C only:
double _dirty_l, _dirty_t, _dirty_r, _dirty_b;  // invalidation rect (object-local, -INF = unset)
```

Boundary determination reuses existing semantics:

- `_cache_flag` (explicit `cacheAsBitmap`) ⇒ boundary;
- `_auto_baked` (auto bake) ⇒ boundary, but a **runtime decision** (see §4.5 and risk 3 in §6).

Add an inline predicate `as_is_boundary(o)` = `_cache_flag || _auto_baked` (in stage B only `_cache_flag` is a
stable boundary; `_auto_baked` degrades back to non-boundary on drop-bake, see §6 risk 3).

### 4.3 Invalidation propagation (write-time marking + bubbling to the root)

**Core invariant**: any write that can change render output must mark **itself** and **every ancestor up to the
root** dirty. **It must bubble to the root, not stop at an inner cacheAsBitmap boundary** — two reasons:
1. `as_render_fp`'s fingerprint folds **through** an inner boundary into its subtree (§3); if marking stops at the
   inner boundary, the outer fingerprint moves while `_render_dirty==0`, producing a continuous `DIRTY_MISS`;
2. a nested cacheAsBitmap parent snapshots the child's bitmap, so when the child re-bakes the parent must re-bake
   too, or the parent blits a stale image.
Non-boundary ancestors never read `_render_dirty` (only the cache branch does), so bubbling through is both safe
and necessary.

```
write leaf.x = 10
  → leaf._render_dirty = 1
  → walk up the parent chain to the root:
      for each ancestor a:
        a._render_dirty = 1
        (no longer stop at _cache_flag: bubble through inner boundaries until parent == NULL)
```

Three categories of write points (list sourced from `as_render_fp`'s field enumeration, §3):

1. **DisplayObject accessor setters**: `x/y/rotation/scaleX/scaleY/alpha/visible/blendMode/mask/scrollRect/
   filters/transform/opaqueBackground/cacheAsBitmap`. These are emitted getter/setter C functions in
   `src/emit.ts`; injection points are unambiguous.
2. **Method calls**: `Graphics` `beginFill/lineStyle/moveTo/lineTo/curveTo/draw*/clear`; `DisplayObjectContainer`
   `addChild/removeChild/setChildIndex/swapChildren/…`; `TextField` `text/appendText/htmlText/setTextFormat/
   scrollV/scrollH/…`; `MovieClip` `gotoAndStop/play/stop` and frame advance (`as_mc_tick`).
3. **Indirect inputs**: `BitmapData` writes (already have the `_px_ver` version counter, which can be read as
   "dirty", §4.5), `Matrix`/`ColorTransform` field writes (`transform.matrix`/`transform.colorTransform` per-field
   setters), SWC timeline frame switches.
4. **Dynamic field writes (`as_dyn_set`)**: `obj[key] = v` goes through vtable reflection, and for DisplayObject's
   render-input fields (`x/y/rotation/scaleX/scaleY/alpha/visible/blendMode/opaqueBackground/transform`) it is a
   **plain field store** (`case 1/2/3/7/11`) that bypasses both the accessor setter and the emitAssign write tail —
   Starling's Juggler tween drives alpha this way through an Object-typed target, which was the root cause of the
   final `DIRTY_MISS` on the real app. Fix: RUNTIME_PREAMBLE declares `as_disp_dirty_hook`; `as_dyn_set` fires it
   after a case 1/2/3/7/11 store; the render preamble's `as_disp_dirty_impl` checks `as_is(obj,&DisplayObject_vt)`
   then `as_mark_dirty`s, and `main` installs it via `as_disp_dirty_wire()`. The `as_is` guard avoids wrongly
   marking same-named fields like `DropShadowFilter.alpha`.

**Key engineering constraint**: dirty marking must cover **all** write points. One miss = that object never
invalidates = boundary cache freezes (same bug class as "fingerprint miss → frozen frame"; `skia.md`
§6.10/§6.14 already hold several measured lessons). This is the largest workload and the largest regression
surface of stage B.

### 4.4 Boundary isolation and local repaint

**Render entry change** (the cache branch in `as_render_object`, currently `src/emit.ts:29717`):

```
// now: hit _cache_flag/_auto_baked → as_render_cached (blit snapshot)
// new: on boundary hit, first ask "dirty or not"
if (boundary && snapshot hit) {
  if (!o._render_dirty) { blit snapshot; }          // reuse, no redraw
  else { re-render this boundary (stage B: full re-bake; stage C: only the dirty region); o._render_dirty = 0; }
}
```

- **Stage B**: boundary dirty → re-bake the whole snapshot (equivalent to today's "drop bake → redraw → re-bake",
  but **removes the sit-still latency**: dirty re-bakes that same frame, no 3-frame idle live pass).
- **Stage C**: boundary dirty → clip by `_dirty_l/t/r/b`, redraw only the pixels inside the dirty rect, blit the
  old snapshot for the rest. This is the "FPS scene only redraws a 90×20 region" shape — highest payoff, hardest
  to get right.

**End-of-frame reset**: `Stage_render` and `ASC_window_render` call `as_clear_dirty(stage)` after the paint
(before snapshot/save), clearing `_render_dirty` on **all** objects (both re-rendered and non-re-rendered — next
frame's dirt accumulates from zero). Companion fix: **the root (stage) does not auto-bake** — otherwise a baked
root turns any descendant write into a whole-window tear-down + re-bake.

### 4.5 Relationship to the frame fingerprint (the key tradeoff)

The fingerprint `as_render_fp` is **read-time probing** (every frame, O(tree)); dirty marking is **write-time
setting** (O(1) on write, O(dirty) on read). They are not equivalent replacements; each has a use:

| Use | Current | New |
|---|---|---|
| Window-level "skip Present when unchanged" | `render_fp` (whole-tree hash) | **switch to** a global dirty epoch (`ASC_dirty_epoch`), bumped on write, O(1) "dirty this frame?" test |
| cacheAsBitmap invalidation | fingerprint change → drop bake | **switch to** write-time dirty marking (AIR-aligned) |
| auto-bake trigger | sit still 3 frames then bake | **switch to** write-time dirty marking (bake on change, no sit-still latency) |
| Render-input full set (miss-prevention list) | `as_render_fp` hashed fields | **keep as the source** of the write-point injection list, but no longer execute per frame |

**Migration strategy (regression guard, switch + removal now done)**: stage B ran **parallel first, switch later**. New
marking coexisted with the existing fingerprint, and the `DIRTY_MISS` probe verified "fingerprint changed ⇔ dirty
set" true-iff-true across all examples; once zero, `_cache_flag` invalidation and the auto-bake trigger both moved
to write-time dirty marking and `as_render_fp`'s drop-bake was deleted. Stage C step two **removed the per-frame
whole-tree hash entirely**: the window Present-skip key changed from `w->render_fp == _window_fp` to the global
`ASC_dirty_epoch` (bumped on write); `as_render_fp` became `as_render_states` (settles MovieClip/SimpleButton state
only, no hashing); `_auto_fp` / fingerprint helpers / `DIRTY_MISS` diagnostic were deleted.

`BitmapData`'s `_px_ver`/`_uid` version counters (currently read by the fingerprint) keep their **semantics**
under dirty marking — they remain the authoritative "BitmapData content changed" signal, only changing from
"read by fingerprint every frame" to "directly mark dirty on write". This is the most delicate part of stage B:
one `BitmapData` may be displayed by several `Bitmap`s, and writing it must dirty **all** Bitmaps referencing it
(the current scheme bumps `_px_ver` globally so every Bitmap's fingerprint changes, naturally covering this).

---

## 5. Staged implementation

> Stage letters only denote implementation order within this document; on actual start they go into `TODO.md`'s
> roadmap under the project's "stage three hundred sixty-five +" global numbering.

### Stage A: boundary-semantics consolidation (documentation, mostly exists)

- [ ] Establish `cacheAsBitmap` as the "explicit repaint boundary" in docs (§4.1); add a comparison section to
  `skia.md`.
- [ ] Inventory the boundary-semantics difference between `_cache_flag` / `_auto_baked`; make explicit
  "stable boundary (explicit) vs runtime boundary (automatic)".
- **Acceptance**: no code behavior change, docs only; existing `unit: render/*` and `examples/autobake-*.as`
  stay green.

### Stage B: write-time dirty marking + boundary-level invalidation (core)

> **Implementation status (stage three-sixty-nine)**: write points now cover every render input (DisplayObject
> fields/accessors, container structure, MovieClip frames, Graphics, Transform, Bitmap/BitmapData reverse edges,
> TextField, Stage) plus seven runtime-internal states (focus, selection/caret, IME composition, caret blink,
> filter fields, Stage3D, SimpleButton hover) plus dynamic field writes (`as_dyn_set` hook), and fixes for the
> `as_mark_dirty` short-circuit bug, autoSize missed marking, nested-cacheAsBitmap non-bubbling, and dynamic
> field-write missed marking. Real-app `DIRTY_MISS` is zero and **the switch is done**: invalidation is now
> `_render_dirty`-driven (`as_render_fp` no longer drops the bake — it only feeds the window Present-skip key and
> the `DIRTY_MISS` diagnostic); the auto-bake trigger moved from a 3-frame sit-still to “still = not dirty”, and the
> cache branch distinguishes explicit `cacheAsBitmap` (dirty → re-bake this frame) from auto-bake (dirty → tear the
> boundary down, still → re-bake).
> **Stage C step two (remove the per-frame fingerprint hash) is landed**: `as_render_fp` is deleted and replaced by
> `as_render_states` (settles MovieClip/SimpleButton state only); the window Present-skip key became the global
> `ASC_dirty_epoch` (bumped on write); `_auto_fp` / fingerprint helpers / `DIRTY_MISS` / `ASC_DIRTY_TRACE` are all
> deleted; the auto-bake trigger moved into `as_render_object` before the cache decision.
> **Stage C step one (dirty-rect infrastructure) is landed**: `DisplayObject` gains `_dirty_full/_dirty_l/t/r/b`;
> `as_mark_dirty` is upgraded to whole-object dirty (sets `_dirty_full`); new `as_dirty_merge` (guards non-finite
> rects) and `as_mark_dirty_rect` (merge + `as_bounds_xform` upward transform) are added; `as_clear_dirty` recurses
> to clear the flag and rect (**not yet enabled**). The rectangle is **written but not read** — incremental re-bake
> is the next step.

- [x] Add `_render_dirty` field and `as_is_boundary` predicate to `DisplayObject` (§4.2).
- [x] Following `as_render_fp`'s field list, inject `as_mark_dirty(o)` + upward propagation into every render-input
  write point (§4.3). **Covered**: the nine plain fields (`x/y/rotation/scaleX/scaleY/alpha/visible/blendMode/`
  `opaqueBackground`) + `width`/`height`/`scale9Grid`/`filters`/`mask`/`scrollRect`/`cacheAsBitmap` accessors,
  `addChild`/`removeChild` structure, `MovieClip` frame advance, `Graphics` draw commands (via `_owner`),
  `Transform.matrix/colorTransform` (via `_owner`), `Bitmap.bitmapData`/`smoothing`, `BitmapData`'s 13 mutators
  (via `_refs` reverse edges), `TextField` text/format/colour/scroll write points, `Stage.color/align/scaleMode`,
  and dynamic field writes (`as_dyn_set` → `as_disp_dirty_hook`).
- [x] Change `as_render_object`'s cache branch: an explicit `cacheAsBitmap` re-bakes on `_render_dirty` (drop +
  same-frame re-bake), an auto-bake tears the boundary down and falls through to the live filters/content path;
  no sit-still latency (§4.4 stage B).
- [x] Remove the drop-bake from `as_render_fp`: `_auto_fp` stays (window Present-skip key + `DIRTY_MISS`
  diagnostic), the `_auto_still` settle counter and `ASC_AUTO_BAKE_FRAMES` macro are deleted.
- [x] `_render_dirty` reset (§4.4) — implemented as **clear-on-consume** (cleared right before the cache branch
  re-bakes), not a unified end-of-frame reset.
- [x] **Parallel verification → switch**: dirty-marking ≡ fingerprint true-iff-true (§4.5); switch only after full
  `node test.ts` green. The probe is in place (`ASC_DIRTY_TRACE` + `DIRTY_MISS`: a fingerprint move with
  `_render_dirty==0` reports a missed write point; after the switch it is diagnostic only, no fallback). The first
  TalkMED run produced **many `DIRTY_MISS`** and located them as "fingerprint inputs ≠ AS3 write points" — seven
  runtime-internal-state write points were then added; the second re-run still reported misses, further located as
  the `as_mark_dirty` `!o->_render_dirty` short-circuit bug (a non-boundary child stays dirty across frames while
  an ancestor boundary is cleared that frame, so the next frame's bubble is skipped) — now fixed to walk the full
  chain; the third re-run located the autoSize missed mark; the fourth (subtree dump) located nested cacheAsBitmap
  non-bubbling; the fifth (dump enhanced to all fingerprint fields) located Starling Juggler's dynamic alpha write
  — fixed via `as_disp_dirty_hook`, after which real-app `DIRTY_MISS` is zero; the sixth post-switch run is still
  `DIRTY_MISS` zero with no crash.
- **Acceptance**:
  - `temp/` probe: writing `x` twice → second write (dirty already set) re-bakes same frame, no 3-frame sit-still
    (via `ASC_BAKE_TRACE` timestamps).
  - Per-item draw slope stops jittering from drop-bake idling (§6.14 hover A/B).
  - `test/unit/render.ts` source pins: dirty field exists, `as_is_boundary`, injection-point coverage list,
    cache branch distinguishes explicit vs auto, fingerprint no longer drops the bake.

### Stage C: intra-boundary dirty-rect/subtree incremental repaint (hardest, highest payoff)

- [x] **Remove the per-frame fingerprint hash**: `as_render_fp` deleted → `as_render_states` (settles
  MovieClip/SimpleButton state only); window Present-skip key became the global `ASC_dirty_epoch` (bumped on write);
  deleted `_auto_fp` / fingerprint helpers / `DIRTY_MISS` / `ASC_DIRTY_TRACE`.
- [x] Add `_dirty_l/t/r/b` + `_dirty_full` to `DisplayObject` (§4.2).
- [x] Dirty-rect merge/bubble: `as_dirty_merge` (guards non-finite rects) + `as_mark_dirty_rect` (merge + reuse
  `as_bounds_xform` upward transform to parent coords); `as_mark_dirty` sets whole-object dirty (`_dirty_full=1`).
  **Precise-rect write points landed**: closed shapes (`drawRect`/`drawCircle`/`drawEllipse`) carry a precise rect
  via `as_gpath_mark_rect` (including the `_max_sw` stroke spread), and `as_gflush` uses the accumulated bounds
  (no longer whole-object dirty); open paths (`moveTo`/`lineTo`/`curveTo` …) and the nine plain fields still use
  `as_mark_dirty` whole-object dirty (their bounds are unknowable at write time).
- [x] **Intra-boundary incremental re-bake (bake_patch)**: when a boundary is dirty with `_dirty_full==0` and no
  filter, `as_render_cached` repaints only the dirty rect into the retained raster surface (`_cache_surface`, released
  and re-registered on rebuild, with a finalizer that distinguishes SkImage/SkSurface by kind): `save` +
  `clipRect(_dirty_*)` + `clearRect(_dirty_*)` + local repaint + re-snapshot. `_dirty_full` or a filter repaints the
  whole retained surface (`reset` + clear + repaint); size/phase change still rebuilds (bake_rebuild). An explicit
  `cacheAsBitmap` no longer clears `_render_dirty`/`_cache_valid` in `as_render_object` — that is deferred to
  `as_render_cached`, which clears on consume; an auto-bake still tears down to live.
- [x] Enable the end-of-frame reset (`as_clear_dirty`) together with incremental re-bake: `Stage_render` and
  `ASC_window_render` call `as_clear_dirty(stage)` after the paint (before snapshot/save), zeroing every object's
  `_render_dirty`/dirty rect so the next frame accumulates from zero. This also fixes the missed auto-bake write
  point it exposed: **the root (stage) no longer auto-bakes** (the trigger adds `o->parent != NULL`) — otherwise a
  baked root turns any descendant write into a whole-window tear-down + re-bake, exactly the stage forty-seven
  "repaint the whole 2000×1360 frame for a 90×20 region" cost this stage exists to remove.
- **Acceptance**:
  - [x] FPS counter scene (`TODO.md` stage forty-seven's 90×20 region): `examples/fps-counter.as` keeps a still
    background auto-baked (bakes once, then blits) while a per-frame-changing region stays live; `ASC_BAKE_TRACE=1`
    shows bake_on/bake_rebuild once rather than a whole-frame re-bake every frame.
  - [x] `showRedrawRegions` upgrades from "accepted but no overlay" to "actually outlines the dirty rect":
    `as_render_cached` records the just-redrawn rect (`redrawn` + `rl/rt/rr/rb`) and strokes a 1px outline after the
    blit (`ASC_show_redraw_regions`/`as_show_redraw_regions`); `examples/show-redraw-regions.as` pins the pixels of
    "whole-boundary rebuild outlines the whole boundary, incremental re-bake outlines only the dirty rect".
  - [x] Pixel pin: a scrolling list redraws only the scrolling content, the fixed header does not move for a frame:
    `examples/scroll-header-pin.as` keeps the header outside the list container, scrolling only changes
    `list.scrollRect` (dirty bubbles to the list and its ancestors), so a `BitmapData.draw` before/after sample shows
    the header byte-identical while the scroll window's content moves.

> **Post-stage-C addition (v0.4.343, stage 378)**: the stage C incremental re-bake initially never fired in a real
> asaotui interaction — `bake_patch` was re-widened back to `_dirty_full` by two whole-object invalidation sources:
> ① `Graphics_clear` unconditionally calls `as_mark_dirty(g->_owner)` first (the first step of a `clear`+`drawRect`
> recolour already erases the precise rect); ② asaotui `paintSelf` rewrites `backing.alpha` every frame, and the
> render-input scalar field write tail marks whole-object dirty unconditionally. Fix: `Graphics_clear` uses the old
> accumulated bounds as a precise dirty rect (empty graphics marks nothing); render-input **scalar** field stores
> (double/bool) change-detect so an unchanged value skips the mark (impure RHS is hoisted first; pointer/boxed fields
> stay unconditionally dirty); asaotui's `backing.alpha` writes only on change. Under `ASC_BAKE_TRACE=1`, recolouring
> `s1` in `asaotui/probes/widgets/repaint-boundary` now makes `stable` emit `bake_patch` (dirty rect = `s1`'s bounds),
> so the incremental re-bake benefit is actually exercised. See TODO.md stage 378.

> **Post-stage-C addition (v0.4.345, stage 380)**: `x`/`y` are render inputs, and their write sites used to
> take the whole-object `as_mark_dirty` — so an auto-bake boundary dropped its bake in that frame and re-baked the
> whole box on the next one. A pure translation does **not** change what the subtree contains (a bake lives in the
> object's own local space: the surface carries `translate(-bxo,-byo)` and the blit applies the live CTM, so the
> raster is exact at any offset), so `x`/`y` now route to `as_mark_moved`: only the **ancestor chain** is dirtied,
> and the moved object keeps `_cache_valid`, so the next frame blits the existing raster. rotation/scale are NOT in
> that set (they change the bake's device resolution, i.e. the raster must be redone); a `_mask_user` object falls
> back to the whole-object path (a mask's position is an input to an object that need not be an ancestor); a
> sub-pixel move is still caught by the device-phase check (`_cache_phx/_cache_phy`) and paints live. Real-app bake
> trace: `bake_patch` was always 0 and every small change re-baked the whole 354×841 box (0.67 Mpx); example-level
> A/B: rebuilds 12 → 10, re-baked area 15430 → 14260 px. See TODO.md stage 380; pixel oracle
> `examples/autobake-move.as`, structural pins `render/MovedBake` in `test/unit/render.ts`.

### Stage D (optional, independent enhancement): DisplayList recording + replay

- [ ] Record a boundary's draw commands into a DisplayList (like `SkPicture`); static content only replays +
  translates, never regenerates draw commands.
- **Explicitly not committed for the first version**: large effort, partially overlaps the dirty-rect approach;
  only start if stage C still misses target.

---

## 6. Risks and boundaries (reported honestly)

1. **A missed mark = frozen frame.** The largest risk, and the same bug class as the existing auto-bake
   "fingerprint miss" (`skia.md` holds several measured lessons). Mitigation: §4.5's parallel-then-switch, so the
   fingerprint catches misses during stage B.
2. **Write-point coverage is the largest workload.** Nine lines — `DisplayObject`/`Graphics`/`TextField`/
   `Container`/`MovieClip`/`BitmapData`/`Matrix`/`ColorTransform`/SWC frame scripts — all need injection, aligned
   with the actual "direct field write vs accessor" emission shape. Underestimating it keeps stage B red for a
   long time.
3. **auto-bake as a "runtime boundary" drifts**: `_auto_baked` degrades back to non-boundary on drop-bake, so the
   boundary set changes every frame; dirty propagation into "was a boundary last frame, isn't now" objects can
   bubble too far or not far enough. Stage B should dirty-mark **only explicit `_cache_flag` first**, switching
   auto-bake last (§4.5 order).
4. **Enhancement vs AIR-isomorphic boundary**: switching `cacheAsBitmap` invalidation to dirty marking is an
   **AIR-aligned implementation fix**, not an enhancement; but "new `RepaintBoundary` class / auto-inserted
   boundaries" (§4.1 optional) is **beyond AIR** and must be opt-in, off by default.
5. **Cross-backend differences**: web (WASI + emcc) has no `Present`, so dirty-layer skip and GPU compositing
   must be forked per backend; Windows D3D12 vs macOS Metal boundary re-render costs differ, and stage C dirty-rect
   clipping needs real-machine verification on both (Windows can't be verified locally today — record in `TODO.md`).
6. **Interaction with `BitmapData.draw` / filter passes**: those paths "bake onto another canvas" (`skia.md` §6.12
   phase/origin), so the dirty rect's "object-local coordinates" on those non-window canvases needs its own
   semantics, or the clip window reads wrong.

---

## 7. Acceptance and regression overview

- **Semantic alignment**: `cacheAsBitmap` on/off pixel output stays **byte-identical** (the existing
  `examples/autobake-origin.as` pins must stay green) — dirty marking only changes "when to redraw", never "what
  to draw".
- **Behavior alignment**: same `.as` run on both ends (AOT + `mxmlc`/`adl`), `cacheAsBitmap` invalidation timing
  and pixels match (AIR's cacheAsBitmap is write-time; after the switch it should be closer to adl than today).
- **Structure pins**: `test/unit/render.ts` adds source pins for the dirty field, `as_is_boundary`, injection-point
  list, end-of-frame reset, dirty-rect merge.
- **Performance**: after stage B the `output/perf/chat` `panel_192` slope stops jittering from drop-bake idling;
  after stage C the FPS scene's redraw area drops to region level.
- **Full regression**: each stage ends with a green `node test.ts` + bilingual doc sync + version bump (§2.7).

---

## 8. References

- [`skia.md`](skia.md) §6.10–§6.14: full measurements for auto-bake / cacheAsBitmap / frame fingerprint /
  single-primitive folding.
- [`gc.md`](gc.md) §6: incremental GC per-frame budget and write barrier (the orthogonal performance line).
- `src/emit.ts`: `as_mark_dirty`/`as_mark_dirty_rect`/`as_clear_dirty`, `as_render_states`, `as_render_cached`
  (rebuild/patch/full retained repaint + showRedrawRegions outline), `as_render_object` (auto-bake trigger with the
  root exclusion), `as_render_object_content`, `ASC_window_render`, `Stage_render` (end-of-frame reset).
- `TODO.md` stage forty-seven (`947-948`): the original record of the dirty-rect invalidate pipeline.
