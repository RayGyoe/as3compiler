# Self-built Precise GC Design (Mark-Sweep + Shadow Stack)

> Corresponds to roadmap **stage fifty-seven** (target v0.3.57 → v0.3.58, highest priority).
> This document is the technical argumentation and design draft at the project-kickoff stage; the concrete
> implementation details follow the GC-1 ~ GC-4 sub-stages.

---

## 1. Background and Goals

### 1.1 Why GC Is Needed

Stage fifty-six fixed "per-frame event-dispatch temporary allocations", reducing the leak from 39 KB/s to
0.85 KB/s. The remaining 0.85 KB/s **is not a compiler bug, but the language semantics of "no GC"**:

- Animation's per-round `new TweenLite` + vars literal + PropTween (`malloc`, ~300 B/s)
- User-code string concatenation (`Fps` per-second `text.text`, `TweenDemo` per-round `trace`, arena, ~550 B/s)

These objects are reclaimed by AVM2's GC in AS3; under AOT, the arena (bump allocator, program lifetime) and
scattered `malloc` (never freed) are never cleared. Long runs (10 hours in user testing) keep growing.

### 1.2 Goals

1. **Eliminate slow leaks completely**: animation temporary objects (TweenLite/vars/PropTween/closures) +
   strings are all reclaimable.
2. **Native and WASI double-target behavior consistent** (this is the key constraint for the approach choice,
   see §2).
3. **Do not break correctness**: better to not reclaim than to mis-reclaim (mis-reclaim = dangling pointer =
   random crash, far more dangerous than a leak).

---

## 2. Approach Choice: Self-built Precise GC Is the Only Viable Path

### 2.1 Boehm bdwgc is out immediately (key technical fact)

Boehm-Demers-Weiser GC is the most mature conservative GC for C — `-lgc` link, `malloc`→`GC_MALLOC`, `free`
becomes a no-op, consistent with the AGENTS.md §2.9 rule "link mature libraries for heavy lifting". **But it
physically fails under WASI**:

> Boehm's core mechanism is **conservative stack scanning** — scanning the bytes of the C call stack for
> "pointer-like" values as the root set. But **WebAssembly's call stack lives in VM-managed separate memory,
> not in linear memory**, so C code cannot see it, let alone scan it.

Therefore:
- Under the `wasm32-wasip1` target, Boehm's stack scan fails and cannot find any roots;
- bdwgc's wasm port is either extremely immature or requires a hand-written shadow stack fed to it — once you
  hand-write a shadow stack, it degrades to a half-self-built solution, and still bears the conservative GC's
  false-retention defect (a stack integer that happens to look like a pointer won't be reclaimed), losing on
  both ends.

### 2.2 The Decisive Advantage of Precise GC

The root set of a precise GC (exact tracing) is **explicitly registered** (shadow stack) and does **not
depend on scanning the call stack**. Therefore its behavior is **completely identical** on native and WASI —
this is precisely the decisive advantage of precise GC when "WASI is a target".

| Approach | Maturity | Precision | WASI feasibility | Fit |
|---|---|---|---|---|
| Boehm bdwgc | ★★★★★ | conservative | ❌ (stack scan fails) | High but excluded by WASI |
| Ravenbrook MPS | ★★★ | can be precise | needs heavy porting | complex interface, high integration cost |
| **Self-built mark-sweep** | — | **precise** | ✅ (no stack dependency) | **only viable, and project already has the enumeration foundation** |

### 2.3 Why Self-building Is Feasible Here (key)

The difficulty of precise GC is "how to precisely enumerate pointers in the object graph". The project
**already has all the enumeration infrastructure**, greatly lowering the self-building barrier:

| Existing foundation | Location | Role for precise GC |
|---|---|---|
| `as_value` clean `tag + num + ptr` | `runtime.ts:208` | tags 3/4/6/7 precisely indicate whether `ptr` is a pointer, **precise marking** (not guessing) |
| `as_prop` reflection table `{name, type, offset}` | `emit.ts:411` | types 1~7 precisely enumerate whether each user-class field is a value/reference/boxed, **precise object-graph traversal** |
| `as_method` reflection table + vtable super chain | `runtime.ts:170/248` | mark parent-class fields along the inheritance chain |
| Builtin structure layouts known | `runtime.ts` | pointer fields of as_array/as_object/as_dict/as_closure are hardcoded in code |

### 2.4 V8 Orinoco Reference: What to Borrow and Not (2019 trash-talk)

V8's Orinoco project transformed stop-the-world GC into **parallel + incremental + concurrent** (plus
idle-time). Against this project, first recognize a **decisive constraint**, then discuss borrowing:

> **WASI single-threaded**: `wasm32-wasip1` has no `pthread`, so helper threads do not exist.

| V8 technique | Dependency | Feasibility here |
|---|---|---|
| **Parallel** (multiple threads share mark) | helper threads | ❌ WASI has no threads |
| **Concurrent** (background-thread GC) | helper threads | ❌ WASI has no threads |
| **Incremental** (main-thread sliced mark) | main thread only | ✅ **the only viable way to eliminate jank** |
| **Idle-time GC** (use frame slack for GC) | embedder frame loop | ✅ this project has `Stage_dispatchFrame`, naturally combines |

**Conclusion**: WASI single-threading cuts V8's parallel/concurrent; the only portable piece is
**incremental (incremental marking)** — this is exactly the direction of §5 GC-4, V8 confirms its correctness,
and fills in the key implementation details (tri-color marking + write barrier, see §6).

**The generational hypothesis's lesson**: V8 splits the heap into young/old generations based on "most objects
are short-lived"; young uses semi-space copying GC, paying only the "surviving objects" cost. This assumption
**also holds here** (animation temporaries TweenLite/vars/PropTween are `new` each round and die each round).
But V8's semi-space is a **moving GC** (copies survivors and updates all pointers), which is a huge cost for
our precise GC + shadow stack (must update shadow-stack roots, as_prop reflection fields, and all pointers in
globals). Therefore:

- **Borrow the idea**: generational (small young heap, frequent fast scans; large old heap, infrequent scans)
  reduces the scan volume per pause;
- **Don't copy the implementation**: abandon moving/semi-space, keep **non-moving mark-sweep** (no pointer
  updates), and do mark-sweep for the young generation too — just a smaller heap and faster scan. This is the
  "generational + non-moving" compromise, trading away semi-space's "zero fragmentation + only pay for
  survivors" (copying GC's implicit compaction) for the huge engineering simplification of "no pointer
  updates".

---

## 3. Existing Object Layout Inventory (input to GC migration)

Current runtime-object allocation methods and pointer fields (line numbers refer to `src/runtime.ts`):

| Structure | Definition line | Allocation | Pointer fields (need mark) |
|---|---|---|---|
| `as_value` (box) | 208 | value type, stored with host | `ptr` for tags 3/4/6/7 |
| string | — | **bare `char*`**, arena | no sub-pointers (leaf) |
| `as_array` | 409 | `as_alloc` (arena) | `data` (`as_value*`, elements may hold pointers), `input` (`char*`) |
| `as_object` (record) | 680 | `malloc` (`as_heap_bytes` counted) | `vtable`, `keys` (`char**`), `vals` (`as_value*`) |
| `as_dict` | 878 | `malloc` | `keys` (`void**`, strong object references), `vals` (`as_value*`) |
| `as_closure` | 325 | `as_alloc` (arena) | `env` (`void*`, captured environment) |
| `as_class` | 397 | constant/static | `vtable`, `factory` (function pointer) |
| user-class instance | emit-generated | `malloc` | vtable + each field (enumerated by `as_prop` reflection table) |
| `as_regex` | 1309 | `malloc` | internal bytecode/string |

**Key observation**: strings are **bare `char*` with no header**; as_array/as_closure use the arena (no
header); as_object/as_dict/user-classes use malloc. The three have different allocation methods and header
layouts — this is the first thing GC migration must unify (see §4.1).

---

## 4. The Three Missing Pieces (full self-built workload)

### 4.1 GC Heap + Mark-Sweep Core (`runtime.ts`)

**Unified header (external leading)**: every GC-managed object reserves a header **before** the object body
at allocation; `gc_alloc` returns the address after the header. The header uniformly contains:

```c
typedef struct gc_header {
    int type;        // type tag, decides the mark traversal method (see §4.1 table)
    int color;       // tri-color mark state: 0 white / 1 grey / 2 black (for incremental marking, see §6)
    size_t size;     // object body byte count (for sweep freeing)
    struct gc_header* next;   // heap object linked list (for sweep traversal)
} gc_header;
```

**Type tag → mark traversal method**:

| type | Object | Mark traversal |
|---|---|---|
| `GCT_STRING` | string | leaf, no sub-pointers |
| `GCT_ARRAY` | as_array | traverse `data[0..length)`, for each `as_value` mark `ptr` if tag∈{3,4,6,7}; mark `input` |
| `GCT_OBJECT` | as_object(record) | mark all `keys[i]` (strings) + `vals[i]` (as_value recursive) |
| `GCT_DICT` | as_dict | mark all `keys[i]` (object pointers) + `vals[i]` (as_value recursive) |
| `GCT_CLOSURE` | as_closure | mark `env` |
| `GCT_CLASS` | user-class instance | read `vtable` → `props` reflection table, mark fields with type∈{3,6,7} (type 6 ref is a bare pointer, type 7 any is an as_value, type 3 string is char*) |

**Mark-Sweep flow** (tri-color view):
1. **Mark**: from the root set (shadow stack + global roots, §4.2), breadth/depth traverse, set
   `color=black` for each reachable object and recurse into its sub-pointers;
2. **Sweep**: traverse the heap object linked list; objects with `color==white` are freed (`free` back to the
   heap), those with `color==black` reset to `color=white` for the next round.

> In the non-incremental (stop-the-world) implementation, tri-color is implicit (after marking everything is
> black); but the header uses `color` (2 bits) rather than `marked` (1 bit) from the start of the design, so
> that GC-4 incremental marking reuses the same structure directly (see §6), avoiding a second change to the
> header layout.

**Trigger timing**: when `gc_bytes_allocated` accumulates past a threshold (e.g. 1 MiB), trigger at the
**safe point** in the `Stage_dispatchFrame` frame loop. The safe point requires: **all pointer-holding locals
on the call stack are already registered in the shadow stack** (§4.2), otherwise roots cannot be precisely
enumerated at trigger time.

**Pause analysis (the intrinsic cost of stop-the-world)**: on the triggering frame, the main thread pauses
rendering and runs the whole mark + sweep before resuming.
- Pause time ∝ **total objects in the heap** (mark traverses reachable objects + sweep traverses the entire
  object list), **not** ∝ garbage volume;
- Trigger frequency = allocation rate ÷ threshold (**not per-frame GC**, but periodic single jank);
- demo scale (threshold 1 MiB, tens of thousands of objects): one pass is ~1~10ms, dropping **1 frame** under
  a 16ms frame budget, essentially imperceptible;
- Risk: with a larger threshold or accumulated resident objects, pauses reach tens to hundreds of ms, becoming
  visible freezes. **This is the inherent defect of mark-sweep**; adl doesn't jank because AVM2 uses
  incremental + generational GC; the only correct way to eliminate pauses is **incremental marking** (see §6).

### 4.2 Root Set = Shadow Stack (`emit.ts` codegen, largest workload + largest risk)

Precise GC doesn't scan the call stack; instead the **compiler explicitly registers** "every local variable /
parameter / temporary value that may currently hold a pointer" in each function.

**Mechanism**: each generated function registers a stack frame into the global shadow stack at entry, and
deregisters at exit:

```c
void Foo_method(Foo* this, as_value a) {
    gc_frame_enter(/* pointer-holding local array */ ...);   // register at entry
    ...
    gc_frame_leave();                              // deregister at exit
}
```

`gc_frame` records a "GC-scannable memory region", where each element is either an `as_value` (judged a
pointer by tag) or a bare pointer (treated directly as a root). On GC trigger, traverse every frame of the
shadow stack and mark all pointers in the frame.

**This is the largest workload + largest risk**:
- The compiler must, at codegen stage, **precisely enumerate** "all local variables, parameters, and temporary
  as_values that may hold pointers" for each generated function;
- A variable may be "dead" in different ranges within a function (no longer used); if not deregistered and
  left in the shadow stack, it causes false retention (not reclaimed, but still safe); conversely **missed
  registration → object reclaimed too early → dangling pointer → random crash** (far more dangerous than a
  leak).

**Mitigation strategy (better false retention than missed registration)**:
1. Start conservatively: a function registers **all pointer-holding locals for its whole lifetime** (no fine
   liveness analysis); GC only false-retains, never mis-reclaims;
2. Use the same AST pre-scan as `usesArguments*` (already in emit.ts) to enumerate all pointer-holding
   variables that "appear" in a function;
3. Global roots (stage, display list, event registry, `as_timers`, static fields, module-level `g_*` globals)
   are registered separately as **permanent roots**; resident objects should not be reclaimed anyway.

### 4.3 Migrating Allocation Sites

| Object | Current | After migration |
|---|---|---|
| as_array / as_closure | `as_alloc` (arena) | `gc_alloc(GCT_ARRAY/GCT_CLOSURE, size)` |
| as_object / as_dict / user-class / as_regex | `malloc` | `gc_alloc(GCT_*, size)` |
| string | arena bump | `gc_alloc(GCT_STRING, len+1)` |
| resident objects (stage/display list/vtable/static fields) | various | **leave unchanged or register as permanent roots** (not reclaimed anyway) |

Bringing strings into GC is a separate **GC-2** (§5), because strings are bare `char*` with no header, and
currently all string construction (`as_str_from_*`/`as_str_concat`) goes through the arena — the largest
change surface and highest regression risk, hence split into its own sub-stage.

---

## 5. Four-stage Breakdown and Acceptance Criteria

| Sub-stage | Goal | Objects brought into GC | Acceptance |
|---|---|---|---|
| **GC-1** | GC heap + Mark-Sweep + Shadow Stack roots, **native first** | array / object(record) / dict / closure / user-class instances | `examples/stage57.as` long-loop `new` of many objects; `System.totalMemory` doesn't grow linearly per round; window demo MEM stable over long runs; old examples regression-free |
| **GC-2** | strings into GC | strings | memory stable after frequent `trace`/`text.text` concatenation |
| **GC-3** | WASI target verification + long-run regression | (same) | reclaims under `--target wasm` too; native+wasm long runs with zero dangling |
| **GC-4** | optional optimization: generational / write barrier + **incremental marking** | — | no significant frame-rate drop; after heap growth, **pause time no longer grows linearly with heap** (incremental marking spreads mark across frames, each frame only does a small slice — the correct way to eliminate jank; generational only reduces scan volume, doesn't eliminate pauses) |

**MVP boundary (GC-1)**: stage/display list/event system — these "resident objects" are GC roots anyway (in
AS3 reachable from stage, and shouldn't be reclaimed); **only animation temporaries** (TweenLite/vars/
PropTween/closures) are reclaimed, exactly hitting the bulk of the stage-fifty-six residual leak.

> **The complete technical route for incremental marking is in §6**. This section keeps only acceptance
> criteria; the tri-color state machine, mark stack, write-barrier concrete code, compiler injection-point
> list, boundary cases, and overhead estimate are all expanded once in §6, not left as "to be decided later".

---

## 6. Complete Incremental-Marking Design (GC-4 landing)

> This section is GC-4's **complete landing technical route**, expanded once, not left as "to be decided
> later". GC-1~GC-3 first deliver stop-the-world mark-sweep (§4.1); GC-4 layers incremental marking on top
> seamlessly — the header's tri-color field, mark stack, and write barrier are all reserved from GC-1, avoiding
> a second change.

### 6.1 Goal and Principle

Stop-the-world pause ∝ total objects in the heap (§4.1 pause analysis); a large heap becomes a visible
freeze. Incremental marking's solution is:

> **Spread mark work across multiple frames, each frame advancing only a small slice under a fixed budget**;
> the main thread keeps running rendering and user code between mark slices. Per-frame pause drops from
> `O(heap)` to `O(budget)`, so no long pauses no matter how large the heap grows.

The cost is twofold: ① mark must become a "pausable/resumable" state machine (no longer recursive DFS); ②
during incremental marking the main thread mutates the object graph, so a write barrier must maintain the
tri-color invariant (otherwise missed mark → mis-reclaim).

### 6.2 Data Structures: Mark Stack + Tri-color State

Tri-color abstraction: objects are **white** (unvisited) / **grey** (visited, sub-nodes unscanned) / **black**
(sub-nodes scanned). `gc_header.color` (§4.1) is exactly these states.

Incremental marking can no longer rely on the C recursion stack (cannot pause midway), so use an **explicit
mark stack** for grey objects:

```c
// global incremental-marking state (runtime.ts, reserved from GC-1, zero overhead when IDLE)
typedef struct {
    int state;                // 0 IDLE / 1 MARK / 2 SWEEP
    gc_header** grey_stack;   // grey-object work stack (push on greying)
    int grey_top;             // stack top (stack only grows until marking completes)
    int grey_cap;             // stack capacity (realloc on demand, mind §8 on migration)
    size_t budget;            // per-frame budget (object count)
} gc_inc;
```

### 6.3 State Machine and Sliced Scheduling

```
IDLE ──(gc_bytes_allocated > threshold)──> MARK   // all roots greyed and pushed
MARK ──(per-frame gc_step(budget): pop grey objects and scan their sub-pointers)──> continues
MARK ──(grey stack empty)──> SWEEP                     // marking complete
SWEEP ──(per-frame sweep one slice, reclaim white, reset black to white)──> IDLE
```

**Scheduling point**: `Stage_dispatchFrame` calls `gc_step()` at the start of each frame (before broadcasting
ENTER_FRAME). budget uses a **deterministic budget** of "scan at most N objects per frame" (better than a
time budget: cross-platform consistent, no `clock` dependency). N is tunable, typical 100~500, keeping per-
frame GC time < 1ms.

**Single-step pseudocode** (once per frame):

```c
void gc_step(void) {
    if (gc_inc.state == GC_MARK) {
        size_t n = gc_inc.budget;
        while (n-- > 0 && gc_inc.grey_top > 0) {
            gc_header* g = gc_inc.grey_stack[--gc_inc.grey_top];
            gc_mark_children(g);   // scan g's sub-pointers (§4.1 type dispatch), grey white children and push them
            g->color = GC_BLACK;   // sub-nodes scanned, turn black
        }
        if (gc_inc.grey_top == 0) gc_inc.state = GC_SWEEP;  // marking complete
    } else if (gc_inc.state == GC_SWEEP) {
        gc_sweep_step(gc_inc.budget);   // per-frame sweep one slice, reclaim white
        if (done) gc_inc.state = GC_IDLE;
    }
}
```

### 6.4 Write Barrier Complete Implementation

**Why needed**: during incremental marking the main thread runs user code; a **black** object writes a
reference to a **white** object between mark slices, and that white will no longer be scanned (the black's
subtree is already scanned) → missed mark → mis-reclaimed.

**Solution: Dijkstra insertion barrier** — on every "reference write", if the written value is white, **grey
it and push it**, maintaining the invariant:

> **During marking, a black object does not directly point to a white object.**

```c
// runtime.ts
static inline void gc_write_barrier(void* src) {
    if (gc_inc.state != GC_MARK) return;   // zero overhead outside marking (one int compare)
    if (src == NULL) return;
    if (!gc_in_heap(src)) return;          // skip non-GC-heap objects (string literals/static data)
    gc_header* h = gc_hdr(src);
    if (h->color == GC_WHITE) {            // written white reference, grey it
        h->color = GC_GREY;
        gc_grey_push(h);                   // push onto grey stack, scanned soon
    }
}
```

**Key detail**: `gc_in_heap(src)` is a heap address-range check. Under precise GC, `as_value`'s `ptr` always
points into the GC heap, but the runtime has **non-heap pointers** (`"true"`/`"false"`/`"null"` string
literals, static vtables, static strings) that must be excluded quickly by address range, otherwise a literal
would be misread as a GC header to access its `color` field.

### 6.5 Allocation During Incremental Marking (allocation barrier)

Objects newly allocated during marking, if initialized white, would be mis-reclaimed in this sweep (they
haven't been marked yet). Standard solution: **objects allocated during incremental marking are initialized
black directly**:

```c
void* gc_alloc(int type, size_t size) {
    gc_header* h = ...;
    h->color = (gc_inc.state == GC_MARK) ? GC_BLACK : GC_WHITE;  // new objects during marking directly black
    ...
}
```

Safety argument: a new object, just allocated and not yet referenced by any black object, being set black
won't be mis-reclaimed by sweep; if the user subsequently writes it into some black object's field, the write
barrier (§6.4) protects that edge, preserving the invariant.

### 6.6 Compiler Injection-point List (emit.ts)

The write barrier has two landing points, with division of labor as follows:

| Write type | Landing point | Compiler injection needed? |
|---|---|---|
| Dynamic writes `a[i]=v` / `d[k]=v` / `o.k=v` / `o[k]=v` (reflection) | `as_array_set` / `as_dict_set` / `as_object_set` / `as_dyn_set` | **No** — barrier built into these 4 setter functions (runtime handles uniformly, compiler zero changes) |
| **Direct field write** `o.field = v` (C direct assignment, not through a function) | `emitAssign`'s Member branch | **Yes** — codegen adds a `gc_write_barrier(...)` after the assignment |
| Local/parameter `as_value` assignment (`var x:* = ref`) | variable declaration/assignment | **No** — locals are in the shadow stack (§4.2) and already scanned, no barrier needed |

**Only "direct field writes" need compiler injection**, and only when the field type is 3/6/7
(string/ref/any, i.e. holds a pointer); types 1/2/4/5 (number/bool/int/uint) are values with no pointer, so
skip. Injection form:

```c
// AS3: this.target = otherObj;   (field type is 6 ref or 7 any)
this->target = otherObj;
gc_write_barrier(otherObj);       // appended by codegen
```

> The reason the barrier is built into the 4 dynamic setters rather than all in codegen is that dynamic
> setters are "the single convergence point of all dynamic writes"; adding one `gc_write_barrier` in the
> runtime covers every call site, more cohesive and less error-prone than adding it to dozens of `emitAssign`
> branches in codegen. Direct field writes have no function convergence point (they are C direct assignments),
> so they need explicit codegen injection.

### 6.7 Boundary Cases and Invariants

| Case | Handling |
|---|---|
| **Tri-color invariant** | during marking black doesn't directly point to white; write barrier maintains it |
| **Grey stack overflow** | stack only grows until marking completes, capacity `realloc`s on demand; update references after migration (same as the §8 `realloc` item) |
| **Grey stack empty = marking complete** | grey objects are always in the stack (push on greying), empty stack means no grey → transition to SWEEP |
| **Writes during sweep** | no mark in progress during sweep, barrier inactive (correct: colors are finalized, sweep only reclaims white) |
| **Non-heap pointer misjudgment** | `gc_in_heap` address-range check excludes literals/static data (§6.4) |
| **Budget exhausted, return midway** | mark stack/cursor persist in `gc_inc`, next frame resumes from the breakpoint, no recomputation |

### 6.8 Overhead Estimate

- **Outside marking**: each dynamic setter + each direct field write adds one `gc_inc.state != GC_MARK` int
  compare (a few nanoseconds), essentially unmeasurable.
- **During marking**: total mark workload is **the same** as stop-the-world (just spread out); the extra cost
  is the write barrier's one grey-and-push on "black writes white" — extremely rare in animation scenarios.
- **Net effect**: per-frame pause `O(budget)`, completely eliminating the linear degradation of "larger heap →
  longer freeze", aligning with AVM2's imperceptible GC experience.

### 6.9 Relationship with GC-1~GC-3

GC-1~GC-3 deliver stop-the-world mark-sweep, **but the header uses `color` (tri-color) rather than `marked`
(single-color) and reserves the `gc_inc` structure**, so GC-4's incremental marking is "add a state machine +
mark stack + write barrier", without needing to change the header layout or the shadow-stack mechanism. GC-4
only affects the trigger timing (`Stage_dispatchFrame` per-frame `gc_step()` instead of a one-shot
`gc_collect()`) and the write-barrier injection; everything else is reused.

---

## 7. Relationship with Existing Reflection Tables (reuse, not rebuild)

| Existing facility | GC use |
|---|---|
| `as_prop` reflection table (`emit.ts:411` `propTypeTag`) | **precise field enumeration** of user-class instances: type 6 ref / 7 any / 3 string are references to mark, 1 number/2 bool/4 int/5 uint are values to skip |
| `as_vtable_header` super chain | mark parent-class fields along the inheritance chain (offsets hold under flattened struct inheritance, `offsetof` already valid) |
| `as_value` tag | judge whether an `as_value` holds a pointer (3/4/6/7) and what structure the pointer targets |
| `as_method` table | irrelevant (methods hold no object-graph references; a closure's `env` is the root) |

---

## 8. Core Risk Checklist

| Risk | Consequence | Mitigation |
|---|---|---|
| **Shadow Stack misses one root** | object reclaimed too early → dangling pointer → **random crash** | start conservatively: register all pointer-holding locals for the whole function lifetime; AST pre-scan exhausts; permanent roots registered separately |
| False retention | something that should be reclaimed isn't, leak remains | acceptable (safer than crash); liveness optimization possible later |
| GC trigger not at a safe point | stack locals not registered get reclaimed | only trigger at the `Stage_dispatchFrame` safe point (all frame functions have returned, shadow stack only has permanent roots) |
| `realloc`-migrated array dangling pointers | `as_dict`/`as_timers` etc. invalidate old pointers on `realloc` | GC only scans pointers registered in the shadow stack/global roots; references must be updated after `realloc` (existing code already notes this) |
| **Stop-the-world pause** | trigger-frame main-thread block, visible jank on large heap | safe-point trigger + threshold controls frequency; after heap growth must introduce **incremental marking** (GC-4) to truly eliminate it, otherwise pauses grow linearly with heap |
| WASI lacks `getrusage` etc. | memory stats degrade | `privateMemory` already degrades to `totalMemory` (stage fifty-two), GC unaffected |

---

## 9. References

- AGENTS.md §2.4 "memory-management red line": forbid hot-path arena temporary allocations (after GC lands
  this red line can be relaxed to "temporaries go through GC")
- `TODO.md` stage fifty-six (leak localization) + stage fifty-seven (this document's kickoff)
- AS3/AVM2 precise GC semantic reference: avmplus `GCObject` / Ruffle `gc_arena` (`Gc<'gc>`), borrow semantics
  only, no porting
- V8 Orinoco design (trash-talk, 2019): https://v8.dev/blog/trash-talk —— parallel/concurrent not portable due
  to WASI single-threading; incremental + generational ideas borrowable (see §2.4 / §6)
