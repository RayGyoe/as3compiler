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

### 4.3 Invalidation propagation (write-time marking + upward bubbling)

**Core invariant**: any write that can change render output must mark **itself** and **every ancestor up to the
nearest boundary** dirty. Stop at the boundary — the boundary isolates invalidation; the parent only sees the
boundary's bitmap and does not need to know which leaf changed inside.

```
write leaf.x = 10
  → leaf._render_dirty = 1
  → walk up the parent chain:
      for each ancestor a:
        a._render_dirty = 1
        if a is a boundary (_cache_flag) → stop (the boundary itself is dirty, parent untouched)
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

**End-of-frame reset**: after `Present`, `ASC_window_render` clears `_render_dirty` on **all** objects (both
re-rendered and non-re-rendered — next frame's dirt accumulates from zero). Timing aligns with the current
`as_render_fp` per-frame update of `_auto_fp`.

### 4.5 Relationship to the frame fingerprint (the key tradeoff)

The fingerprint `as_render_fp` is **read-time probing** (every frame, O(tree)); dirty marking is **write-time
setting** (O(1) on write, O(dirty) on read). They are not equivalent replacements; each has a use:

| Use | Current | New |
|---|---|---|
| Window-level "skip Present when unchanged" | `render_fp` (whole-tree hash) | **keep** `render_fp`, but its input can be "dirty this frame?" instead of "re-hash every field" |
| cacheAsBitmap invalidation | fingerprint change → drop bake | **switch to** write-time dirty marking (AIR-aligned) |
| auto-bake trigger | sit still 3 frames then bake | **switch to** write-time dirty marking (bake on change, no sit-still latency) |
| Render-input full set (miss-prevention list) | `as_render_fp` hashed fields | **keep as the source** of the write-point injection list, but no longer execute per frame |

**Migration strategy (regression guard)**: stage B runs **parallel first, switch later**. New dirty marking
coexists with the existing fingerprint for a while:
- write points that set dirty also leave `as_render_fp` running unchanged (don't delete fingerprint code yet);
- use asserts/probes to verify "fingerprint changed ⇔ dirty set" holds **true-iff-true** across all examples;
- after full `node test.ts` is green, switch `_cache_flag` invalidation to dirty marking, auto-bake last;
- finally **keep** `as_render_fp`'s field enumeration as the source document for the write-point injection list,
  and delete the per-frame execution.

This degrades the "missed mark" risk from "frozen frame" to "fingerprint catches it during stage B".

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

> **Implementation status (stage three-sixty-seven)**: write points now cover every render input (DisplayObject
> fields/accessors, container structure, MovieClip frames, Graphics, Transform, Bitmap/BitmapData reverse edges,
> TextField, Stage) plus seven runtime-internal states (focus, selection/caret, IME composition, caret blink,
> filter fields, Stage3D, SimpleButton hover). The fingerprint fallback is still present (parallel phase). The
> TalkMED real-machine re-run and the switch are not yet done — see TODO.md stage three-sixty-seven.

- [x] Add `_render_dirty` field and `as_is_boundary` predicate to `DisplayObject` (§4.2).
- [x] Following `as_render_fp`'s field list, inject `as_mark_dirty(o)` + upward propagation into every render-input
  write point (§4.3). **Covered**: the nine plain fields (`x/y/rotation/scaleX/scaleY/alpha/visible/blendMode/`
  `opaqueBackground`) + `width`/`height`/`scale9Grid`/`filters`/`mask`/`scrollRect`/`cacheAsBitmap` accessors,
  `addChild`/`removeChild` structure, `MovieClip` frame advance, `Graphics` draw commands (via `_owner`),
  `Transform.matrix/colorTransform` (via `_owner`), `Bitmap.bitmapData`/`smoothing`, `BitmapData`'s 13 mutators
  (via `_refs` reverse edges), `TextField` text/format/colour/scroll write points, and `Stage.color/align/scaleMode`.
- [x] Change `as_render_object`'s cache branch to "re-bake if dirty, else blit", removing the sit-still latency
  (§4.4 stage B). (Currently coexists with the fingerprint drop: dirty → clear + `_cache_valid=0` same-frame re-bake;
  the fingerprint fallback catches any missed write point.)
- [~] `_render_dirty` reset (§4.4) — implemented as **clear-on-consume** (cleared right before the cache branch
  re-bakes), not a unified end-of-frame reset.
- [~] **Parallel verification**: dirty-marking ≡ fingerprint true-iff-true (§4.5); switch only after full
  `node test.ts` green. The probe is in place (`ASC_DIRTY_TRACE` + `DIRTY_MISS`: a fingerprint drop with
  `_render_dirty==0` reports a missed write point); the first TalkMED real-machine run produced **many
  `DIRTY_MISS`** and located them as "fingerprint inputs ≠ AS3 write points" — seven runtime-internal-state
  write points were then added (stage three-sixty-seven); the re-run (recompile + `ASC_DIRTY_TRACE`) still needs
  a windowed Skia run.
- **Acceptance**:
  - `temp/` probe: writing `x` twice → second write (dirty already set) re-bakes same frame, no 3-frame sit-still
    (via `ASC_BAKE_TRACE` timestamps).
  - Per-item draw slope stops jittering from drop-bake idling (§6.14 hover A/B).
  - New `test/unit/render.ts` source pins: dirty field exists, `as_is_boundary`, injection-point coverage list,
    end-of-frame reset.

### Stage C: intra-boundary dirty-rect/subtree incremental repaint (hardest, highest payoff)

- [ ] Add `_dirty_l/t/r/b` to `DisplayObject` (§4.2).
- [ ] Write-point injection **merges** dirty rects: `leaf._dirty` ∪ parent `_dirty` bubbles along the chain (a
  parent's dirty rect covers all dirty descendants).
- [ ] Boundary redraw uses **dirty-region clipping**: `save` + `clipRect(_dirty_*)` then redraw only the content
  inside the dirty rect, blit the old snapshot elsewhere; or (dirty-subtree variant) redraw only the dirty
  subtree, blit the rest.
- **Acceptance**:
  - FPS counter scene (`TODO.md` stage forty-seven's 90×20 region): redrawn pixel area drops from whole-frame to
    small-region, asserted via `ASC_BAKE_TRACE` / a redraw-area counter.
  - `showRedrawRegions` upgrades from "accepted but no overlay" (current `emit.ts:40320`) to "actually outlines
    the dirty rect" — AIR's debug overlay, which doubles as the pixel-level regression oracle for dirty rects.
  - Pixel pin: a scrolling list redraws only the scrolling content, the fixed header does not move for a frame
    (`BitmapData.draw` before/after signature comparison).

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
- `src/emit.ts`: `as_render_fp` (`29022`), `as_render_cached` (`29293`), `as_render_object` (`29559`),
  `as_render_object_content` (`29839`), `ASC_window_render` (`30736`), `Stage_render` (`30174`).
- `TODO.md` stage forty-seven (`947-948`): the original record of the dirty-rect invalidate pipeline.
