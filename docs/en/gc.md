# Self-built Precise GC Design (Mark-Sweep + Shadow Stack)

> Corresponds to roadmap **stage fifty-seven** (target v0.3.57 → v0.3.58, highest priority).
> This document is the technical argument and design draft from the project-inception phase; the concrete
> implementation details follow what landed in each of the GC-1 ~ GC-4 sub-stages.

---

## 1. Background and Goals

### 1.1 Why GC Is Needed

Stage fifty-six fixed the "temporary allocation per frame of event dispatch", dropping the leak from 39 KB/s
to 0.85 KB/s. The remaining 0.85 KB/s is **not a compiler bug but a language semantics without GC**:

- Each animation round's `new TweenLite` + vars literal + PropTween (`malloc`, ~300 B/s)
- User code string concatenation (`Fps` doing `text.text` every second, `TweenDemo` doing `trace` every
  round, arena, ~550 B/s)

These objects are reclaimed by AVM2's GC in AS3, but under AOT the arena (a bump allocator, program lifetime)
and scattered `malloc` (not reclaimed) never clear. Long-running use (measured by a user over 10 hours) grows
continuously.

### 1.2 Goals

1. **Clear the slow leak to zero**: animation temporaries (TweenLite/vars/PropTween/closures) + strings are
   all reclaimable.
2. **native and WASI behave identically** (this is the key constraint on the approach choice, see §2).
3. **Do not break correctness**: rather not reclaim than wrongly reclaim (a wrong reclaim = a dangling
   pointer = a random crash, far more dangerous than a leak).

---

## 2. Approach Choice: Self-built Precise GC Is the Only Viable Path

### 2.1 Boehm bdwgc is out immediately (key technical fact)

Boehm-Demers-Weiser GC is the most mature C conservative GC: link `-lgc`, change `malloc`→`GC_MALLOC`, make
`free` a no-op, consistent with AGENTS.md §2.9's iron rule "link mature libraries for heavy work". **But it
physically fails under WASI**:

> Boehm's core mechanism is **conservative stack scanning** — scanning the bytes of the C call stack to find
> "pointer-like" values as the root set.
> But **WebAssembly's call stack lives in VM-managed separate memory, not in linear memory**, so C code cannot
> see it or scan it at all.

Therefore:
- Under the `wasm32-wasip1` target, Boehm's stack scanning fails and cannot find any root;
- bdwgc's wasm port is either extremely immature or requires a hand-written shadow stack to feed it roots —
  and once you hand-write a shadow stack, it degrades into half self-built work while still carrying the
  conservative GC's false-retention defect (a stack integer that happens to look like a pointer is not
  reclaimed), the worst of both worlds.

### 2.2 The Decisive Advantage of Precise GC

A precise GC (exact tracing) has an **explicitly registered** root set (a shadow stack) and **does not rely
on scanning the call stack**. So its behavior on native and WASI is **exactly identical** — precisely the
decisive advantage of precise GC when "WASI is included as a target".

| Approach | Maturity | Precision | WASI feasibility | Fit |
|---|---|---|---|---|
| Boehm bdwgc | ★★★★★ | conservative | ❌ (stack scanning fails) | high but excluded by WASI |
| Ravenbrook MPS | ★★★ | can be precise | needs a large port | complex interface, high integration cost |
| **self-built mark-sweep** | — | **precise** | ✅ (does not rely on the stack) | **the only viable option, and the project already has the enumeration foundation** |

### 2.3 Why Self-building Is Feasible Here (key)

The difficulty of a precise GC is "how to precisely enumerate the pointers in the object graph". The project
**already has the entire enumeration infrastructure**, greatly lowering the bar:

| Existing foundation | Location | Role for the precise GC |
|---|---|---|
| Clean `as_value` `tag + num + ptr` | `runtime.ts:208` | tags 3/4/6/7 precisely indicate whether ptr is a pointer, enabling **precise marking** (not guessing) |
| `as_prop` reflection table `{name, type, offset}` | `emit.ts:411` | types 1~7 precisely enumerate whether each user-class field is a value/reference/boxed, enabling **precise traversal of the object graph** |
| `as_method` reflection table + vtable super chain | `runtime.ts:170/248` | mark parent-class fields along the inheritance chain |
| Builtin struct layouts known | `runtime.ts` | the pointer fields of as_array/as_object/as_dict/as_closure are hard-coded in the source |

### 2.4 V8 Orinoco Reference: What to Borrow and Not (2019 trash-talk)

V8's Orinoco project turned stop-the-world GC into **parallel + incremental + concurrent** (plus idle-time).
Against this project, first recognize a **decisive constraint**, then talk about borrowing:

> **WASI is single-threaded**: `wasm32-wasip1` has no `pthread`, so helper threads do not exist.

| V8 technique | Depends on | Feasible here |
|---|---|---|
| **Parallel** (multiple threads share marking) | helper threads | ❌ WASI has no threads |
| **Concurrent** (background-thread GC) | helper threads | ❌ WASI has no threads |
| **Incremental** (main thread sliced marking) | main thread only | ✅ **the only viable correct answer for eliminating pauses** |
| **Idle-time GC** (do GC in frame slack) | an embedder frame loop | ✅ this project has `Stage_dispatchFrame`, a natural fit |

**Conclusion**: WASI's single-threadedness cuts V8's parallel/concurrent, and the only portable one is
**incremental (incremental marking)** — exactly the direction of §5's GC-4, which V8 confirms as correct and
whose key implementation details it completes (tri-color marking + write barrier, see §6).

**The generational hypothesis's lesson**: V8 splits the heap into young/old generations based on "most objects
die young", using a semi-space copying GC for the young generation and paying only the "surviving objects"
cost. This hypothesis **also holds** for this project (animation temporaries TweenLite/vars/PropTween are new
each round and die each round). But V8's semi-space is a **moving GC** (copying survivors, updating all
pointers), a huge cost for our precise GC + shadow stack (it would require updating shadow-stack roots,
`as_prop` reflection fields, and every pointer in globals). Therefore:

- **Borrow the idea**: generational (a small young heap scanned frequently and fast; a large old heap scanned
  infrequently), reducing the scan volume per pause;
- **Do not copy the implementation**: abandon moving/semi-space and keep a **non-moving mark-sweep** (no
  pointer updates), with the young generation also using mark-sweep, just smaller and faster to scan. This is
  a "generational + non-moving" compromise, sacrificing semi-space's "zero fragmentation + pay only surviving
  cost" (the implicit compaction advantage of copying GC) in exchange for the huge engineering simplification
  of "no pointer updates".

---

## 3. Existing Object Layout Inventory (input to GC migration)

The current runtime objects' allocation methods and pointer fields are as follows (line numbers refer to
`src/runtime.ts`):

| Struct | Definition line | Allocation | Pointer fields (to mark) |
|---|---|---|---|
| `as_value` (box) | 208 | a value type, stored with its host | the `ptr` of tags 3/4/6/7 |
| string | — | a **bare `char*`**, arena | no sub-pointers (leaf) |
| `as_array` | 409 | `as_alloc` (arena) | `data` (`as_value*`, elements may hold pointers), `input` (`char*`) |
| `as_object` (record) | 680 | `malloc` (counted by `as_heap_bytes`) | `vtable`, `keys` (`char**`), `vals` (`as_value*`) |
| `as_dict` | 878 | `malloc` | `keys` (`void**`, strong object references), `vals` (`as_value*`) |
| `as_closure` | 325 | `as_alloc` (arena) | `env` (`void*`, the captured environment) |
| `as_class` | 397 | constant/static | `vtable`, `factory` (function pointer) |
| user class instance | generated by emit | `malloc` | vtable + each field (enumerated by the `as_prop` reflection table) |
| `as_regex` | 1309 | `malloc` | internal bytecode/strings |

**Key observation**: strings are a **bare `char*` with no header**; as_array/as_closure go through the arena
(no header); as_object/as_dict/user classes go through malloc. The three differ in allocation method and
header layout — the first thing GC migration must unify (see §4.1).

---

## 4. The Three Missing Pieces (full self-built workload)

### 4.1 GC Heap + Mark-Sweep Core (`runtime.ts`)

**Unified header (external prefix)**: every GC-managed object reserves a header **before** the object body at
allocation time, and `gc_alloc` returns the address after the header. The header uniformly contains:

```c
typedef struct gc_header {
    int type;        // type tag, decides the mark traversal mode (see the §4.1 table)
    int color;       // tri-color marking state: 0 white / 1 grey / 2 black (used by incremental marking, see §6)
    size_t size;     // object body size in bytes (used to free during sweep)
    struct gc_header* next;   // heap object linked list (swept during sweep)
} gc_header;
```

**Type tag → mark traversal mode**:

| type | Object | Mark traversal |
|---|---|---|
| `GCT_STRING` | string | leaf, no sub-pointers |
| `GCT_ARRAY` | as_array | traverse `data[0..length)`, for each `as_value` mark `ptr` if tag∈{3,4,6,7}; mark `input` |
| `GCT_OBJECT` | as_object(record) | mark every `keys[i]` (string) + `vals[i]` (as_value, recursive) |
| `GCT_DICT` | as_dict | mark every `keys[i]` (object pointer) + `vals[i]` (as_value, recursive) |
| `GCT_CLOSURE` | as_closure | mark `env` |
| `GCT_CLASS` | user class instance | read `vtable` → `props` reflection table, mark fields with type∈{3,6,7} (type 6 ref is a bare pointer, type 7 any is an as_value, type 3 string is a char*) |
| `GCT_VALUE_ARRAY` | as_array's `data` buffer | slot by slot `gc_mark_value` per `as_value` |
| `GCT_PTR_ARRAY` | the payload `data` of a reference-element `Vector.<T>` | item by item `gc_mark_ptr` per `void*` |
| `GCT_RAW` | the payload `data` of a scalar / boxed / interface-element `Vector.<T>` | **leaf, not scanned** (a bare numeric array or a `{obj,vt}` value struct); references pointing at GC objects (a `Vector.<*>`'s boxed slot, an interface element's `obj`) are tracked explicitly by that Vector's `GCT_CUSTOM` callback |
| `GCT_CUSTOM` | the monomorphized `Vector.<T>` struct itself | call `((as_vector_*)b)->mark(b)`, i.e. the generated `as_vector_*_mark`: first `gc_mark_ptr(v->data)`, then supplement per-element tracking for `*`/interface element types |

**Mark-Sweep flow** (tri-color view):
1. **Mark**: starting from the root set (shadow stack + global roots, §4.2), traverse breadth/depth-first,
   setting `color=black` on each reachable object and recursing into its sub-pointers;
2. **Sweep**: traverse the heap object linked list, freeing objects with `color==white` (returning them to the
   heap) and resetting `color=black` objects to `color=white` for the next round.

> In a non-incremental (stop-the-world) implementation the tri-color is implicit (everything is black once
> marking finishes); but the header uses `color` (2 bits) rather than `marked` (1 bit) from the very start so
> that GC-4's incremental marking can directly reuse the same structures (see §6), avoiding a second change to
> the header layout.

**Trigger timing**: when `gc_bytes_allocated` accumulates past a threshold (e.g. 1 MiB), trigger at the
**safepoint** in `Stage_dispatchFrame`'s frame loop. The safepoint requires: **all pointer-holding locals on
the call stack are already registered in the shadow stack** (§4.2), otherwise the roots cannot be precisely
enumerated when triggered.

**Pause analysis (the essential cost of stop-the-world)**: on the triggering frame, the main thread stops
rendering and finishes the whole mark + sweep before resuming.
- The pause time is ∝ **the total number of objects in the heap** (mark traverses reachable objects + sweep
  traverses the whole object list), **not** ∝ the amount of garbage;
- The trigger frequency = allocation rate ÷ threshold (**not a per-frame GC, but a periodic single stall**);
- At demo scale (threshold 1 MiB, tens of thousands of objects): one pass is about 1~10 ms, **dropping one
  frame** in a 16 ms budget, essentially imperceptible;
- Risk: with a larger threshold or accumulated long-lived objects, the pause can reach tens to hundreds of
  ms, becoming a visible freeze. **This is an inherent defect of mark-sweep**, and adl does not stall because
  AVM2 uses incremental + generational GC; the only correct answer to eliminating pauses is **incremental
  marking** (see §6).

> **Landing addendum (after GC-1~GC-4)**: the actual allocator did not use this section's imagined "single
> linked-list traversal" but a **segmented heap + free-list** (`GC_SEG_SIZE = 1 MiB` per segment, first-fit +
> splitting + coalescing), maintaining the live-object list `gc_all` separately from the free list. This gives
> rise to an **oversized-allocation boundary**: when a single request has `size > GC_SEG_SIZE - sizeof(gc_header)`
> (about 1 MiB − 24 bytes of header), fixed-segment splitting can never satisfy the request, causing `gc_alloc`
> to recurse infinitely, repeatedly `malloc(1 MiB)` until VSZ is exhausted — the fix mirrors `as_alloc`'s
> oversized branch: allocate a dedicated segment of `sizeof(gc_header) + size` for `size`, so the next retry
> hits the free-list (`benchmarks/array`'s infinite loop was caused by exactly this).
>
> **Trigger-timing correction**: a frame-boundary safepoint only exists in programs with a
> `Stage_dispatchFrame` frame loop; a headless/console program's `main()` never enters the frame loop, so the
> safepoint never triggers and GC becomes purely manual — unless user code explicitly calls `System.gc()`, it
> only grows and never reclaims (a silent leak rather than a crash). Allocation-intensive console benchmarks
> therefore need `System.gc()` inserted periodically in the loop to actually trigger reclamation.

#### 4.1.1 Segment Return and Allocator Concession (stage eighty-nine / twenty-six)

Once a segmented heap's segment is `malloc`ed it is never returned, so **free blocks go back onto the free
list while RSS does not fall**: measured on Starling Benchmark with 30k objects, the live set was 44 MB /
`heaptotal` 61 MB, yet RSS stayed at 520 MB. Both of the following must be done, and neither alone suffices:

- **Empty-segment release (`gc_release_empty_segs`, rate-limited by `GC_RELEASE_MS = 500`)**: `gc_seg` gains a
  `free_bytes` in-use byte counter (set full on carve, decremented on a `gc_alloc` hit, incremented on a sweep
  free) + a `reap` flag; when due, a single pass over the two free lists removes all free blocks of segments
  where "`free_bytes == size`" (including coalesced blocks), then removes them from `gc_segs` /
  `gc_seg_range` and `free`s them. A "dead segment" must be unlinked before being freed, otherwise the list is
  left with a dangling node. Two call sites: `gc_finish_cycle` (end of round) and `gc_step`'s `GC_IDLE` branch —
  the latter ensures that **after allocation stops** (no new GC rounds) RSS also falls with the live set.
- **Allocator concession (`gc_trim_os`)**: `free()` only returns pages to `malloc`, and macOS's zone keeps
  them rather than returning them to the OS (`heap` measured: 167 MB actually in use sitting in a 388 MB
  reserved zone, of which 263 MB is "empty" and resident). So explicitly call
  `malloc_zone_pressure_relief(NULL, 0)` (`#ifdef __APPLE__`, which the system also calls under memory
  pressure), once before and once after segment release.

> **Why not make GC segments use `mmap` themselves**: `GC_SMALL_SEG_SIZE = 64 KiB` is below macOS `malloc`'s
> mmap threshold, so segment page return already depends on allocator concession; the platform-independent
> win is "unlink then `free` + concede", not changing segment allocation to `mmap`.
>
> **Diagnostic knob `ASC_FRAME_STATS=1`**: every 512 frames print a line with the frame-time distribution
> (`p50/p95/p99/max)`, the GC share, RSS / `heaptotal` / `inuse` / segment count / free bytes (a 512-entry
> ring buffer). To locate "is the stall GC or the scene itself", just look at `gcshare` and `over17ms`. Use it
> together with `ASC_GC_STATS` (per-round detail), `ASC_GC_BUDGET`/`ASC_GC_THRESHOLD` (absolute budget/
> threshold overrides).
>
> **Diagnostic-probe WASI degradation (stage eighty-nine / thirty-one)**: `ASC_GC_STATS`'s "huge-allocation
> attribution" uses `dladdr()` (POSIX/Apple-specific; wasi-libc has the header but not `Dl_info`/`dladdr`) +
> `__builtin_return_address` (a **hard error** on non-Emscripten wasm, unimplemented in LLVM). Both serve only
> diagnostics and do not affect program-visible behavior, so they are conditionally compiled on `__wasi__`:
> `gc_dbg_sym` degrades to a bare address/`"?"`, and the return-address macro `ASC_RETURN_ADDRESS(n)` degrades
> to `NULL`. Before the fix `--target wasm` **would not even compile** (`hello.as` failed too), not merely the
> probe being ineffective.

### 4.2 Root Set = Shadow Stack (`emit.ts` codegen, largest workload + largest risk)

> **Implementation correction (stages fifty-seven ~ eighty-nine)**: what ultimately landed was "**permanent
> roots + frame-boundary safepoint**", without a shadow stack. Reclamation happens only at the safepoint at
> the start of `Stage_dispatchFrame` (`gc_step()`) — at that moment all of this frame's callbacks have
> returned and the root set is only the permanent roots (static fields, module variables, `ASC_win_stage`, the
> `ENTER_FRAME` registry, timers, `as_exception`, and **in-flight async IO job targets** (stage eighty-nine /
> forty-five)), so there is **no need** to enumerate stack locals. The cost is that the safepoint exists only
> in the frame loop, and `System.gc()` (`gc_collect()`) is a user-visible **manual collection point** that can
> trigger at any location. "**Conservative stack scanning for mid-frame collection**" (§4.2.1) is exactly the
> root source added for the latter.
>
> **In-flight jobs must be registered as roots** (stage eighty-nine / forty-five): `gc_mark_internal_roots()`
> calls `as_async_mark_roots()` to walk the job table, marking each job's AS3 target (`j->obj`) as a root —
> otherwise the target, unreferenced while the background thread works, is reclaimed by sweeping and the
> finish thunk's write then dangles. And **it must not be removed from the table from insertion until the
> finish thunk has finished running** (a claimed job is marked `AS_JOB_FINISHING` but stays in the table): the
> thunk will `gc_alloc` (`BitmapData_new`/`Bitmap_new`), and when headless with no frames it goes through
> `gc_alloc`'s allocation-threshold stop-the-world collection, so removing it early would leave an unmarked
> target zeroed — measured: `Loader`'s `contentLoaderInfo` was zeroed to NULL → `Loader__imageFinish+0x34`
> writing `0x18` reported `EXC_BAD_ACCESS` (crash report `async-conc-*.ips`; reverse comparison: removing the
> claimed job early gives 3/3 SIGSEGV).

A precise GC does not scan the call stack; instead the **compiler explicitly registers** "each function's
currently possible pointer-holding locals/parameters/temporaries".

**Mechanism**: each generated function registers a stack frame into the global shadow stack at entry and
unregisters it at exit:

```c
void Foo_method(Foo* this, as_value a) {
    gc_frame_enter(/* array of pointer-holding locals */ ...);   // register at entry
    ...
    gc_frame_leave();                              // unregister at exit
}
```

A `gc_frame` records a span of "GC-scannable memory", where each element is either an `as_value` (deciding
by tag whether it is a pointer) or a bare pointer (taken directly as a root). When GC triggers, it walks
every frame of the shadow stack and marks all pointers within.

**This is the largest workload + largest risk**:
- The compiler must, for each generated function, **precisely enumerate** at codegen time "all possibly
  pointer-holding locals, parameters, and temporary as_values";
- A variable may be "dead" (no longer used) over parts of a function; leaving it in the shadow stack without
  unregistering causes false retention (not reclaimed, but still safe); conversely **missing a registration →
  an object prematurely reclaimed → a dangling pointer → a random crash** (far more dangerous than a leak).

**Mitigation strategy (rather false retention than a missed registration)**:
1. Conservative start: register all pointer-holding locals for a function's **entire lifetime** (no fine
   liveness analysis), so GC only over-retains and never wrongly reclaims;
2. Use the same AST pre-scan as `usesArguments*` (already in emit.ts) to enumerate all pointer-holding
   variables "appearing" within a function;
3. Global roots (stage, display list, event registry, `as_timers`, static fields, module-level `g_*` globals)
   are registered separately as **permanent roots**; long-lived objects should not be reclaimed anyway.

### 4.2.1 Conservative Stack Scanning for Mid-frame Collection (stage eighty-nine / twenty-two)

**Problem**: `System.gc()` is an explicit collection point in AS3 semantics, and the Starling demo's "return
to main menu" calls it (`Game.showMainMenu` → `System.pauseForGCIfCollectionImminent` + `System.gc()`). At
that moment the C call stack still has live AS3 frames, and the objects they hold **exist only in C locals**
(without a shadow stack there is no registration at all).
Measured consequence: the `Event*` being dispatched inside `EventDispatcher.dispatchEventWith` (just popped
from `Event.sEventPool`, held as a C parameter) is swept away by the stop-the-world `gc_collect()`, and then
`Event.toPool` pushes the **already freed** event back into the object pool, and the next `Event.fromPool`
pop gives an object whose `vtable` has become garbage (the memory reused as a `PTR_ARRAY`)
→ `_event->vtable->reset(...)` jumps to address 0 → `EXC_BAD_ACCESS` (the user reported "entering Sprite 3D
and clicking Back crashes").

**Fix**: append a **conservative scan of the current C call stack** (`gc_mark_stack()`) at the end of
`gc_mark_roots()`.
- Window: `[SP, gc_stack_top)`. `gc_stack_top` is anchored by `GC_NOTE_STACK_BASE()` — `emit.ts` emits that
  macro on the **first line** of the generated `main()`, and the macro writes the address of a current local
  into `gc_stack_top`, so the anchor sits on `main`'s stack frame and the scan window covers the whole live
  call chain.
- `setjmp` first spills callee-saved registers to the stack (so locals alive only in registers can be scanned
  too), then they are read word by word with `sizeof(void*)` alignment via `memcpy` and taken as roots by
  value.
- **Only accept words that can plausibly be objects** (`gc_is_object()`): the address falls within a GC
  segment + the header's `type` is a legal value + `color` is legal + `size` is plausible. Unqualified bytes
  (integers, floats, interior pointers in the middle) are skipped.
- **Header validity relies on a magic tag**: the `GCT_*` constants are all offset by `GCT_TAG_BASE 0x47430000`
  (`"GC"`), and **the `type` of a free/split block is explicitly written 0** (`gc_alloc`'s split, new-segment
  carve, `gc_sweep_step`). Thus a stack word that "happens to land in a segment and be aligned like a header"
  is almost impossible to equal a legal tag, avoiding treating garbage as a `GCT_CUSTOM` header and hence
  calling garbage as a function pointer (`gc_scan`'s `GCT_CUSTOM` branch).

**Cost and boundaries**: conservative scanning is "**rather over-retain than miss a mark**" — an over-retained
object is merely one still pointed to by a stale stack slot, surviving until the next collection; if that slot
is not written back with the old value, the next collection reclaims it. Safepoint collection (frame loop)
runs the same `gc_mark_roots()`: at that point the window contains only the run-loop chain (`main` holding
`g_stage`/`g_app` (permanent roots anyway), `Stage_showWindow` holding only `Stage*`), so the consequence is
zero; dead callback frames lie **below** the scanning frame (the stack grows toward lower addresses) and are
not in the window, so they do not leave the previous frame's garbage as long-term roots.

### 4.3 Migrating Allocation Sites

| Object | Current | After migration |
|---|---|---|
| as_array / as_closure | `as_alloc` (arena) | `gc_alloc(GCT_ARRAY/GCT_CLOSURE, size)` |
| as_object / as_dict / user class / as_regex | `malloc` | `gc_alloc(GCT_*, size)` |
| string | arena bump | `gc_alloc(GCT_STRING, len+1)` |
| `Vector.<T>` element payload | `realloc` (**never reclaimed**) | `gc_alloc(GCT_RAW/GCT_PTR_ARRAY, …)` (**stage eighty-nine / twenty-four**, see §6.10) |
| long-lived objects (stage/display list/vtable/static fields) | various allocations | **left as-is or registered as permanent roots** (not reclaimed anyway) |

Bringing strings into GC is listed separately as **GC-2** (§5), because strings are a bare `char*` with no
header, and all current string construction (`as_str_from_*`/`as_str_concat` etc.) goes through the arena —
the largest surface area and the highest regression risk, hence split into an independent sub-stage.

---

## 5. Four-stage Breakdown and Acceptance Criteria

| Sub-stage | Goal | Objects brought into reclamation | Acceptance |
|---|---|---|---|
| **GC-1** | GC heap + Mark-Sweep + Shadow Stack roots, **native first** | array / object(record) / dict / closure / user class instance | `examples/stage57.as`: after a long loop of `new`-ing many objects, `System.totalMemory` does not grow linearly with the round count; a windowed demo runs long with stable MEM; regression of old examples unbroken |
| **GC-2** | strings brought into GC | strings | memory stable after high-frequency `trace`/`text.text` concatenation |
| **GC-3** | WASI target verification + long-run regression | (as above) | reclamation also under `--target wasm`; native+wasm both run long with zero dangling (this acceptance once could only be reproduced with an example where **the exception machinery was optimized away by `-O2`**: once setjmp/longjmp entered a reachable path, the sysroot lacked `__wasm_setjmp`/`__c_longjmp` and other symbols and **the link failed**; **fixed in stage eighty-nine / thirty-five** (the wasm target links `libsetjmp.a` + goes through the standard EH proposal `try_table`), and all four examples have been re-run and match native, see `compile.md` §2 and `temp/wasi-eh/check.sh`) |
| **GC-4** | optional optimization: generational / write barrier + **incremental marking** | — | no significant frame-rate drop; after the heap grows the **pause time does not grow linearly with the heap** (incremental marking spreads marking over multiple frames, doing only a small slice each, which is the correct answer to eliminating stalls; generational only reduces scan volume, not pauses) |

**MVP boundary (GC-1)**: the stage/display-list/event-system "long-lived objects" are GC roots anyway
(reachable from the stage in AS3, and should never be reclaimed), so **only animation temporaries are
reclaimed** (TweenLite/vars/PropTween/closures), hitting exactly the bulk of stage fifty-six's residual leak.

> **The complete technical route for incremental marking is in §6**. This section keeps only the acceptance
> criteria; the tri-color state machine, mark stack, write barrier's concrete code, the compiler injection-point
> list, boundary cases, and overhead estimate are all unfolded in §6 at once, leaving no "to be decided later".

---

## 6. Complete Incremental-Marking Design (GC-4 landing)

> This section is GC-4's **complete landing technical route**, unfolded at once, leaving no "to be decided
> later". GC-1~GC-3 first deliver the stop-the-world mark-sweep (§4.1), and GC-4 seamlessly layers incremental
> marking on top — the header's tri-color field, the mark stack, and the write barrier are all reserved from
> GC-1 on, avoiding a second change.

### 6.1 Goal and Principle

The stop-the-world pause is ∝ the total number of objects in the heap (§4.1 pause analysis), becoming a
visible freeze once the heap grows. The solution of incremental marking is:

> **Spread the marking work over multiple frames, advancing only a small slice of a fixed budget each frame**,
> with the main thread continuing to run rendering and user code between marking slices. The per-frame pause
> drops from `O(heap)` to `O(budget)`, so no matter how large the heap is there is no long pause.

The cost is twofold: ① marking must become a "pausable/resumable" state machine (no more recursive DFS); ②
during incremental marking the main thread mutates the object graph, so a write barrier must maintain the
tri-color invariant (otherwise a missed mark → a wrong reclaim).

### 6.2 Data Structures: Mark Stack + Tri-color State

The tri-color abstraction: objects are **white** (unvisited) / **grey** (visited, children not scanned) /
**black** (children scanned). `gc_header.color` (§4.1) is exactly this three-value state.

Incremental marking can no longer rely on the C recursion stack (it cannot be paused mid-way), so it uses an
**explicit mark stack** holding grey objects:

```c
// global incremental-marking state (runtime.ts, reserved from GC-1 on, zero overhead when IDLE)
typedef struct {
    int state;                // 0 IDLE / 1 MARK / 2 SWEEP
    gc_header** grey_stack;   // grey-object work stack (pushed on greying)
    int grey_top;             // top of stack (the stack only grows until marking completes)
    int grey_cap;             // capacity (realloc as needed, migration note in §8)
    size_t budget;            // per-frame budget (object count)
} gc_inc;
```

### 6.3 State Machine and Sliced Scheduling

```
IDLE ──(gc_bytes_allocated > threshold)──> MARK   // grey and push all roots
MARK ──(each frame gc_step(budget): pop a grey object, scan its sub-pointers)──> continues
MARK ──(grey stack empty)──> SWEEP                     // marking complete
SWEEP ──(sweep a slice each frame, reclaim white, reset black to white)──> IDLE
```

**Scheduling point**: `Stage_dispatchFrame` calls `gc_step()` at the start of each frame (before broadcasting
ENTER_FRAME). The budget uses a **deterministic budget** of "at most N objects scanned per frame" (better than
a time budget: cross-platform consistent, no dependence on `clock`).
A program with no frames (a pure script / a server-side loop / WASI) never reaches this, and is covered by
**`gc_alloc`'s allocation-threshold trigger**, see §6.13.

**The budget and threshold must adapt to the heap, and the slice must be capped (corrected by measurement in
stage eighty-nine / twenty-five)**: a fixed 500 objects/frame constrains only the *pause*, not the
*throughput*. A hundred-thousand-object live set (Starling Benchmark already has ~150k nodes live at about
8000 objects) takes hundreds of frames to complete one MARK+SWEEP round, during which 2~4 MB of garbage is
still produced each frame → the heap climbs all the way to 900 MB (measured
`total=917MB ｜ raw=881.8MB/889`, i.e. 889 unreclaimed `GCT_RAW` payloads), and then the collector's forced
chunk of work drops the frame rate from 120 to 75, cutting the benchmark's ramp-up short. Fix:

- **Slice adaptive and capped**: `budget = min(count/16 + 500, 8000)` (`count` = the number of objects in the
  heap, an O(1) counter). The lower bound preserves progress for a small heap, and the upper bound preserves
  the *pause* — uncapped, the slice grows linearly with the heap, and measured frame rate slides from 120 all
  the way to 47 fps.
- **Adaptive trigger threshold**: `gc_threshold = max(1 MiB, inuse/8)`, starting a new round only when
  garbage is about 1/8 of the heap, avoiding "starting a new marking before the previous round has finished"
  on a large heap.
- Both knobs can be absolutely overridden by the environment variables `ASC_GC_BUDGET` / `ASC_GC_THRESHOLD`
  (for tuning; the default is adaptive).

**Single-step pseudocode** (once per frame):

```c
void gc_step(void) {
    if (gc_inc.state == GC_MARK) {
        size_t n = gc_inc.budget;
        while (n-- > 0 && gc_inc.grey_top > 0) {
            gc_header* g = gc_inc.grey_stack[--gc_inc.grey_top];
            gc_mark_children(g);   // scan g's sub-pointers (§4.1 type dispatch), grey and push white children
            g->color = GC_BLACK;   // children scanned, turn black
        }
        if (gc_inc.grey_top == 0) gc_inc.state = GC_SWEEP;  // marking complete
    } else if (gc_inc.state == GC_SWEEP) {
        gc_sweep_step(gc_inc.budget);   // sweep a slice each frame, reclaim white
        if (done) gc_inc.state = GC_IDLE;
    }
}
```

### 6.4 Write Barrier: Complete Implementation

**Why needed**: during incremental marking the main thread runs user code, and a **black** object between
marking slices writes a reference to a **white** object; that white would never be scanned (the black's
subtree is already scanned) → a missed mark → a wrong reclaim.

**Solution: Dijkstra insertion barrier** — on every "write reference", if the value being written is white,
**grey and push it**, maintaining the invariant:

> **During marking, a black object does not directly point to a white object.**

```c
// runtime.ts
static inline void gc_write_barrier(void* src) {
    if (gc_inc.state != GC_MARK) return;   // zero overhead outside marking (one int comparison)
    if (src == NULL) return;
    if (!gc_in_heap(src)) return;          // skip non-GC-heap objects (string literals/static data)
    gc_header* h = gc_hdr(src);
    if (h->color == GC_WHITE) {            // the written white reference, grey it
        h->color = GC_GREY;
        gc_grey_push(h);                   // push onto the grey stack, scanned later
    }
}
```

**Key detail**: `gc_in_heap(src)` is a heap-address-range test. Under a precise GC every `as_value`'s `ptr`
points into the GC heap, but the runtime has **non-heap pointers** (`"true"`/`"false"`/`"null"` and other
string literals, static vtables, static strings), which must be quickly excluded by address range, otherwise a
literal would be wrongly read as a GC header's `color` field.

### 6.5 Allocation During Incremental Marking (allocation barrier)

An object newly allocated during marking, if initialized to white, would be wrongly collected in this sweep
(it has not been marked yet). The standard solution: **objects allocated during incremental marking are
initialized directly to black**:

```c
void* gc_alloc(int type, size_t size) {
    gc_header* h = ...;
    h->color = (gc_inc.state == GC_MARK) ? GC_BLACK : GC_WHITE;  // new objects during marking are black
    ...
}
```

Safety argument: a new object just allocated and not yet referenced by a black object, set black, will not be
wrongly collected by the sweep; if the user subsequently writes it into some black object's field, the write
barrier (§6.4) protects that edge and the invariant is not violated.

### 6.5.1 Corollary: Pointers Written into a "Fresh GC Block" Must Be Explicitly Re-greyed

§6.5's argument has a **counter-intuitive gap**: the allocation barrier protects the edge "someone points at
the new object", **not** the edge "the new object points at someone else" — because the new block is born
black, it will not be scanned by `gc_scan` again this cycle, so its internal pointer fields (along with the
contents `memcpy`ed in) are **not** marked. Therefore:

> **Invariant (applies project-wide)**: whenever a **pointer** is written into a "GC block newly allocated in
> the current cycle (= born black)", that write point must explicitly call `gc_write_barrier` /
> `gc_write_barrier_value` to re-grey the value, otherwise the target object, if still white, is silently
> reclaimed in this sweep, leaving a dangling pointer.

The easiest kind to miss is **buffer growth**: on grow, `gc_alloc` produces a new block → `memcpy` the old
contents → every pointer in the old contents owes a re-grey. Sites fixed per this rule (stage eighty-nine /
nineteen):

| Site | Location |
|---|---|
| Array growth | `as_array_ensure` |
| XML parse-buffer growth | `as_xml_buf_push` |
| record/object property-table growth | `as_object_set` (the props-growth branch) |
| Dictionary bucket growth | `as_dict_set` |
| Vector growth (four branches: push / unshift / setLength / ensure) | the generated C's single convergence point `as_vector_*_grow(v, cap)` (`emit.ts`): `gc_alloc(GCT_RAW/GCT_PTR_ARRAY)` + `memcpy` + `gc_write_barrier((void*)v->data)`; for reference elements, per-element `gc_write_barrier`, and when `elem.kind == 'any'` the mark callback does per-element `gc_mark_value` |

The criterion is simple: **any combination of "new GC block + pointers moved in from elsewhere" owes a
barrier**, regardless of whether it is an "insert element".

### 6.6 Compiler Injection-point List (emit.ts)

The write barrier has two landing spots, split as follows:

| Write type | Landing spot | Needs compiler injection? |
|---|---|---|
| Dynamic write `a[i]=v` / `d[k]=v` / `o.k=v` / `o[k]=v` (reflection) | `as_array_set` / `as_dict_set` / `as_object_set` / `as_dyn_set` | **No** — the barrier is built into these 4 setter functions (handled uniformly at runtime, zero compiler change) |
| **Direct field write** `o.field = v` (a C direct assignment, no function call) | `emitAssign`'s Member branch | **Yes** — codegen appends a line `gc_write_barrier(...)` after the assignment |
| Local/parameter `as_value` assignment (`var x:* = ref`) | variable declaration/assignment | **No** — locals are in the shadow stack (§4.2) and scanned anyway, no barrier needed |

**Only "direct field writes" need compiler injection**, and only when the field type is 3/6/7 (string/ref/any,
i.e. pointer-holding); types 1/2/4/5 (number/bool/int/uint) are values with no pointers and are skipped.
Injection form:

```c
// AS3: this.target = otherObj;   (field type is 6 ref or 7 any)
this->target = otherObj;
gc_write_barrier(otherObj);       // appended by codegen
```

> The reason the barrier is built into the 4 dynamic setters rather than relying on codegen entirely is that
> the dynamic setters are "the sole convergence point of all dynamic writes": adding one `gc_write_barrier` at
> runtime covers all call sites, which is more cohesive and less error-prone than adding it at dozens of
> `emitAssign` branches in codegen. Direct field writes have no function convergence point (they are C direct
> assignments), which is why codegen must inject explicitly.

### 6.7 Boundary Cases and Invariants

| Case | Handling |
|---|---|
| **Tri-color invariant** | During marking, black does not directly point to white; maintained by the write barrier |
| **Grey stack overflow** | The stack only grows until marking completes, with capacity `realloc`ed as needed; update references after migration (same as §8's `realloc` item) |
| **Empty grey stack = marking complete** | Grey objects are necessarily on the stack (pushed on greying), so an empty stack means no grey → switch to SWEEP |
| **Writes during sweep** | No marking is in progress during sweep, so the barrier has no effect (correct: colors are settled, and sweep only reclaims white) |
| **Non-heap pointer misjudgment** | `gc_in_heap`'s address-range test excludes literals/static data (§6.4) |
| **Budget exhausted, returning mid-way** | The mark stack/cursor persist in `gc_inc`, and the next frame resumes from the breakpoint, with no recomputation |

### 6.8 Overhead Estimate

- **Outside marking**: each dynamic setter + each direct field write adds one `gc_inc.state != GC_MARK` int
  comparison (a few nanoseconds), essentially unmeasurable.
- **During marking**: the total marking work is **the same** as stop-the-world (just spread out), and the
  extra cost is the write barrier's one extra grey-and-push when "black writes white" — a very low proportion
  in animation scenarios.
- **Net effect**: the per-frame pause is `O(budget)`, completely eliminating the linear degradation
  "heap grows → long freeze", aligning with AVM2's imperceptible GC experience.

### 6.9 Relationship with GC-1~GC-3

GC-1~GC-3 deliver the stop-the-world mark-sweep, **but the header uses `color` (tri-color) rather than
`marked` (single-color), and reserves the `gc_inc` struct**, so GC-4's incremental marking is "add a state
machine + mark stack + write barrier", without needing to revise the header layout or the shadow-stack
mechanism. GC-4 only affects the trigger timing (`Stage_dispatchFrame`'s per-frame `gc_step()` replacing the
one-shot `gc_collect()`) and the write-barrier injection, reusing everything else.
### 6.10 Vector Element Payloads Brought into GC (stage eighty-nine / twenty-four)

**Background (a user report of "memory leak during Benchmark testing")**: in the Benchmark scene, at 13279
objects Activity Monitor showed **14.17 GB** resident; measured with `temp/hidpi/mem.py "btn:9,at:160:60"`
it reproduced **255 MB → 14298 MB / 23 s**, then flattened out at 14.3 GB.

**Root cause**: the `as_vector_*` struct itself goes through `gc_alloc(GCT_CUSTOM)`, but the payload of
**scalar/boxed/interface** elements (`vectorElemIsPtr() == false`: number/int/uint/bool/any/interface/…) has
always been a bare `realloc`/`malloc`, **outside the GC heap and never reclaimed** — every growth discards
the old buffer ("every Vector leaks forever"). Amplifier: `VertexBuffer3D_uploadFromByteArray` creates two
full-size `as_vector_number`s on every call, while Starling's
`Effect.uploadVertexData → uploadToVertexBuffer → uploadFromByteArray` runs on **every frame the vertices
change** (the Benchmark's container keeps rotating) → several MB discarded per frame. `leaks` evidence:
`ROOT LEAK: <realloc in as_vector_number_setLength>` (471 cases / 375 MB) + `as_vector_uint_setLength`
(222 cases / 30 MB).

**Fix (two parts)**:
1. **Payload onto the GC heap**: add a leaf type `GCT_RAW` (`gc_alloc` + `memcpy` instead of `realloc`), used
   for scalar/boxed/interface element payloads, while reference elements use `GCT_PTR_ARRAY`; collapse the
   four old growth branches (push/unshift/setLength/ensure) into a single helper `as_vector_*_grow`, where
   the rewrite of `v->data` gets `gc_write_barrier((void*)nd)` (the §6.5.1 invariant). Old isolated payloads
   can then be reclaimed. A payload larger than one segment (e.g. a multi-MB `Vector.<Number>`) is handled by
   `gc_alloc`'s oversized-segment branch, so `gc_is_object`'s size upper bound is relaxed from `GC_SEG_SIZE`
   to `1u << 30`.
2. **Buffer reuse**: `VertexBuffer3D`/`IndexBuffer3D`'s `uploadFromByteArray` is changed to write **in place
   by absolute vertex/index index** (only `setLength` if the payload Vector is not long enough; from stage
   eighty-nine / twenty-six on, the vertex payload is merged into a single `Vector.<uint>` 32-bit word
   buffer, see the next section), and `Context3D_submit` and the generated C's read path both locate by
   `startVertex`/`startIndex` consistently (`as_s3d_upload_vertex/index` needs only `data + startIndex` and
   `numIndices`); `IndexBuffer3D_uploadFromVector` is also changed to **copy** rather than alias the caller's
   Vector (AS3 semantics is a copy, and aliasing would let a later in-place upload modify the caller's object).
3. **Incidentally fix an existing crash (not introduced by this leak)**: `gc_in_heap` originally checked only
   `p >= base`, while all callers need to read the header fields at `p - sizeof(gc_header)`; a stack word
   landing at a **segment start** (conservative stack scanning can hold the segment base address) would make
   that read fall into an unmapped page before the segment → `SIGBUS` (always reproduced by `stage57.as` under
   `-O2`, and by chance not under `-O0`). Changed to require the header itself to fall within the segment.

**Acceptance**: `temp/hidpi/mem.py "btn:9,at:160:60"` → 271 MB → **1219 MB / flat to the second after 4 s**
(14298 MB before the fix); six consecutive "Start benchmark" rounds → 0.00 MB/s after 1651.3 MB (converged,
no per-round growth), `leaks` reduced from 2478 cases / 407 MB to **399 cases / 68 KB**; a mid-run screenshot
confirmed the baked scene renders correctly (egg shape/textures/depth sorting normal); `demo_all2.py` 12
scenes with zero crashes; `node test.ts` 101 passed / 0 failed.

---

### 6.11 The Allocator's Size Classes and "Large Payload" Reuse (stage eighty-nine / twenty-five)

First-fit on a single chain + splitting fragments an entire chunk of memory on **repeated large requests with
size drift**:

- Measured symptom: `resv=1127MB segs=1031 freeblk=40693 freeb=1060MB` — 1.1 GB reserved, of which 1 GB hangs
  on the free list **yet none of it can be used**. The reason is that a freed multi-MB payload on one chain is
  **nibbled and fragmented** by the small objects that follow it under first-fit (carving a small piece each
  time), so when the next multi-MB request arrives there is no block large enough on the chain → a new segment
  is opened directly. `Effect.uploadVertexData` rebuilds a multi-MB `VertexBuffer3D` every frame (Starling's
  own semantics: if `vertexData.size > _vertexBufferSize`, purge + create anew), so "one new segment per
  frame" = a high RSS water mark.
- Fix (`src/runtime.ts`):
  1. **Two free lists**: `gc_free` (< `GC_BIG_CLASS` = 256 KiB) and `gc_free_big` (≥ 256 KiB). Both requests
    and frees are classified by their own size (`gc_free_for(size)`), so large requests no longer have to
    skip small objects one by one. (Note: a "single chain + skip foreign blocks" implementation was once
    tried, and large requests then had to scan tens of thousands of small blocks each frame, making
    `example/gc_barrier.as` time out at O(n²) — classified lists are the correct answer.)
  2. **New segments sized by request class**: small requests open a `GC_SMALL_SEG_SIZE` (64 KiB) segment. If
    small requests also opened 1 MiB segments, the remainder after carving the request would belong to the
    "large" class, the small chain would always be empty → every small allocation would open a new segment
    (measured `segs=26995`).
  3. **Round a large payload's capacity up to a power of two** (`as_vector_*_grow`, only when
    `cap*sizeof(elem) ≥ 256 KiB`): the element count drifts by only a few hundred between frames
    (`need = startVertex*stride + count`), and after rounding up it falls back into the same size class, so
    the block freed last frame can be reused as-is this frame; small payloads keep exact sizes (rounding only
    wastes memory).
  4. After a new segment is split, **carve it by the request size first and then retry** (the new segment
    itself is a large block, and a small request would skip it forever → infinite recursion).

---

### 6.12 Precision of the Segment-Return Accounting (stage eighty-nine / twenty-seven)

**Background**: segment return (§4.1.1) decides "there is nothing in this segment" based on
`s->free_bytes == s->size`, i.e. "every byte in the segment is on the free list". This decision **is
equivalent to "empty" only when the counter is exact**.

**Defect (the true root cause of the crash on the second benchmark run)**: when the allocator takes a block
from the free list, if the remainder is smaller than `GC_MIN_BLOCK` (32 B) it does not split, handing the
block to the caller at its **original size** — but the accounting still deducts by the **request size**:

```c
size_t remain = h->size - size;
if (remain >= GC_MIN_BLOCK) { /* split, h->size = size */ }
free_bytes -= sizeof(gc_header) + size;   // ← under-deducts (h->size - size) when not split
```

Thus the segment's `free_bytes` is **larger** than the true free amount, and the deviation **accumulates
permanently** (up to +31 B per unsplit allocation). When the deviation happens to equal the space occupied by
live objects in the segment, `free_bytes == size` holds → this segment **full of live objects is returned to
the OS by `free(s->base)`** → malloc immediately reuses it (measured: handed to the arena/`ByteArray.data`) →
all objects in the segment become someone else's memory:

- The user-reported crash: `BatchProcessor_addMesh + 360`, bad address `0x3fef9782a0000150` — a `MeshStyle`'s
  vtable word became a double;
- The reproduced crash: `BenchmarkScene_onEnterFrame + 1572`, `ldr x12, [x10, #0x10]`, with `x10` taken from
  the global `gc_all` (0x1013b15c0) — **the object-list head itself became a double**.
- Both bad values' base address is `0x3fef9782a0000000` = double `0.9872449040412903` = the benchmark's
  `_container.scale` (the product of `scale *= 0.99` / `/= 0.9993720513` accumulating) → the same "a double
  landing in a pointer slot" tell, and it explains why "it only crashes on the second run" (the freed block's
  contents were not yet overwritten the first time).

**Fix**: move the accounting to **after** the split, deducting by the block's **actual size**:

```c
/* split */
free_bytes -= sizeof(gc_header) + h->size;   // h->size after splitting is exactly the true occupancy
```

Now `free_bytes` is strictly equal to "the sum of (header + size) of every block on the free list", and
`free_bytes == size` again is equivalent to "the segment is truly empty". (The previously unsplit remainder
does not go onto any free list, so it is not counted in free_bytes — it belongs to "an over-allocated block",
not to "free space".)

**Acceptance and regression**:

- `examples/gc_seg_reap.as`: a loop of "allocate a string with payload p → discard → `System.gc()` → retrieve
  at p-4" (remainder 4 B < 32 B → unsplit), while keeping 8 live string canaries; `test.ts` runs it with
  `ASC_GC_AUDIT_STRICT=1`. Before the fix this example **always** produced
  `free_bytes DRIFT seg=… free_bytes=65552 size=65536 delta=16` and `abort()`ed (rc=134); after the fix it
  prints `gc-reap-ok`.
- Full-machine regression: `bench2.py 480` (Starling benchmark run 10 rounds) with no crash, and the
  `gc-audit` report at **0 lines** (before the fix the same harness gave `rc=-11` on rounds 3~5, with 8 DRIFT
  lines / several RELEASING lines).
- `node test.ts`: 103 passed / 0 failed.

**Diagnostic knobs** (the `ASC_GC_AUDIT` family, all off by default, zero overhead on the production path):

| Variable | Effect |
|---|---|
| `ASC_GC_AUDIT=1` | Before each segment return, recompute each segment's actual occupancy from the live-object list and reconcile with `free_bytes`: `DRIFT` (the counter is inexact), `GHOST` (a freed block still on `gc_all`), `RELEASING … with N LIVE bytes` (about to free a segment that still has live objects); also detects dangling references during marking (pointing at a swept block). A healthy program produces **zero output** — any output means a defect. |
| `ASC_GC_AUDIT_STRICT=1` | As above, but `abort()`s on the first violation (for `test.ts` assertions, see `gc_audit_fail`). |
| `ASC_GC_RELEASE=0` | Disables segment return (A/B: isolating "return"-related crashes). |

**Decision principles** (pitfalls hit in this stage): reporting budgets must be **separated by category**
(`gc_audit_reports` / `drift` / `release`), otherwise a flood of informational reports (DRIFT) would crowd out
the decisive `RELEASING`/`DANGLING`, directly derailing the first diagnosis; also, **address-range-historical
criteria are unusable**: `malloc` immediately reuses a just-freed segment's address (with the
arena/`ByteArray.data` inside it), so "the pointer falls within a segment range that was once freed"
necessarily yields many false positives (measured: all 32 were `ByteArray.data`), and it was removed in this
stage.

### 6.13 Allocation-threshold Trigger for Non-GUI Targets (stage eighty-nine / forty-one)

**Background**: there is only one advance point for GC — `gc_step()` at the `Stage_dispatchFrame` frame
boundary (plus the manual `System.gc()` trigger). A program with no frames never reaches it, so "however much
is allocated, that much grows": `gc_bytes_allocated` keeps climbing, `gc_inc.state` stays `GC_IDLE`, and the
heap is never reclaimed.

**Fix (both directions are necessary, neither alone suffices)**:

| Mechanism | Location | Effect |
|---|---|---|
| Frame-driven flag | `gc_frame_driven = true` at the start of `gc_step()` | `gc_step()`'s only caller is the emitted `Stage_dispatchFrame`, so "has entered `gc_step`" ⇔ "this program has a frame safepoint". Programs with frames continue with GC-4's **incremental slicing** (preserving a bounded per-frame pause) |
| Allocation-threshold trigger | At the `gc_alloc` entry: `if (!gc_frame_driven && state == GC_IDLE && gc_bytes_allocated >= gc_trigger()) gc_collect();` | Before any frame has ever been dispatched, allocation itself does a **stop-the-world collection** by threshold (`max(1 MiB, live heap/8)`, §6.3) |

**Why stop-the-world here**: this path has no frame deadline to protect, and the total work is the same;
slicing would only introduce a state machine into a path that "must be correct from any call site". It is the
same kind of operation as the already-supported `System.gc()` (which can trigger inside live AS3 frames):
`gc_mark_roots` runs the **conservative stack scan** as usual (setjmp spills callee-saved registers to the
stack and then scans word by word, §4.2.1), so live locals at every level of the call chain are still roots.
The trigger point is placed at the **very front** of `gc_alloc` (the new object does not yet exist), so the
sweep can never treat "the object being allocated" as unreachable garbage.

**Invariant**: `main`'s first statement is `GC_NOTE_STACK_BASE()` (earlier than any AS3 statement), so the
stack scan always has the stack base when triggered from `gc_alloc`.

**Acceptance**:

- `examples/gc_alloc_threshold.as`: never calls `System.gc()` and never dispatches a frame; the ~5 MB garbage
  peak over 100 rounds is held to ~1 MB (the threshold floor), asserting "the peak is bounded"
  (`peak < base + 1.5 MB`) and "live objects are not wrongly collected" (a module-level linked list of 100
  nodes checked item by item; the **function-local** array survives below the collection point — module
  variables are C globals and permanent roots anyway and cannot test the stack, so a local is required);
- **Reverse comparison 1** (changing the trigger condition to `if (0)`): must FAIL —
  `FAIL: peak stays bounded without any System.gc() (peak=17772328 base=0)` (without reclamation the peak is
  ≈17 MB, growing linearly);
- **Reverse comparison 2** (turning off `gc_mark_stack`'s conservative stack scan): must FAIL —
  `FAIL: the local burst returned its own length` (the live local is reclaimed, proving the stack scan is a
  **load-bearing** condition of this path);
- `node test.ts`: 112 passed / 0 failed (including all GC assertion examples).

**Known trade-off (intentionally retained)**: once a frame has been dispatched, the allocation-threshold
trigger **yields** to the frame-boundary incremental reclamation — this is to avoid sacrificing GC-4's bounded
per-frame pause. If frames then stop entirely, the behavior matches that before this stage (relying on
`System.gc()` as a fallback).

### 6.14 Byte Buffers Brought into GC (stage eighty-nine / forty-two)

**Background**: `ByteArray.data` (grow / compress / uncompress) and `BitmapData.pixels` have always gone
through the arena / `malloc`. They hang on **GC-visible fields** (entries of type 6 in `ByteArray_props` /
`BitmapData_props`), so reachability has always been judged correctly, but the memory itself was not on the
GC heap — when `System.gc()` reached them it only did a `gc_mark_ptr` of "a non-heap pointer, safely skipped"
(§6.4), and they were **never reclaimed**.

**Why this leak stayed invisible for so long**: `malloc`/arena blocks are not in
`System.totalMemoryNumber`'s books (those three items are the arena + a small amount of runtime's own malloc +
the GC heap), so a program that repeatedly creates/discards `ByteArray`s shows **no growth at all** in the
books. Measured with the same churn (40 rounds × 1 MB): before migration the books showed 0 MB and RSS
**+40 MB without falling**; after migration the books showed 0 MB and RSS peaked at 3.6 MB (segments reused).
So a visible memory "leak" must be judged by RSS; the books can only see the GC heap.

**Fix**: add a leaf type `GCT_BYTES` (`GCT_TAG_BASE + 16`), changing the two buffer kinds to
`gc_alloc(GCT_BYTES, n)`:

| Location | Original | Current |
|---|---|---|
| `ByteArray_set_length` / `as_ba_grow` / `as_ba_grow_pos` | `as_alloc(cap)` + `memcpy`, old block discarded (arena, not reclaimed) | `gc_alloc(GCT_BYTES, cap)`, old block becomes GC garbage |
| `ByteArray.compress` / `uncompress` | `as_alloc(dst)` (the zlib destination buffer) | `gc_alloc(GCT_BYTES, dst)`; uncompress's failed block on each retry is also GC garbage |
| `URLLoader` binary read (`ba->data`) | `as_alloc(sz)` | `gc_alloc(GCT_BYTES, sz)` |
| `BitmapData` construction | `malloc(w*h*4)` | `gc_alloc(GCT_BYTES, w*h*4)` (`gc_alloc` zeroes it; the fill loop overwrites afterwards) |
| Image decode into `BitmapData.pixels` (`Loader.loadBytes` / `BitmapData.loadFile`) | directly adopting glue's `malloc`ed ARGB buffer | `memcpy` into a GC buffer + `free` the glue buffer (glue is C++ and cannot call into GC; ownership is therefore single: `pixels` exists only on the GC heap) |
| `BitmapData.dispose()` | `free(bd->pixels)` | `bd->pixels = NULL` (**drop the reference**: `free`ing a GC buffer wrecks GC's free list) |

**Why the bytes need not be scanned**: `GCT_BYTES` is a leaf (`gc_scan`'s case just `break`s). There are no
pointers to follow in the bytes — it is **reachable** only because some class field points at it, and that
field's reflection-table entry (type 6) has already been followed by GCT_CLASS's scan (§6.4 / §7). Keeping it
separate from `GCT_RAW` (Vector element payloads) is so that `ASC_GC_STATS`'s type books can distinguish
"per-frame Vector payloads" from "possibly missed byte buffers" — exactly the information leak hunting needs.

**Write barrier**: all sites writing these fields get `gc_write_barrier` (grow / set_length / compress /
uncompress / URL read / BitmapData construction and the two adopts). The reason is the same as §6.5.1: during
incremental marking the object may be BLACK, while the just-`gc_alloc`ed buffer is WHITE.

**The non-moving heap is the premise of these changes**: `gc_alloc` does not move objects, so a buffer pointer
handed to Skia / Metal stays valid for the duration of the call; moreover **both sides are copy semantics**
(`SkImages::RasterFromPixmapCopy`, `[tex replaceRegion:...withBytes:]`), so there is no dangling risk of "the
library keeping our buffer".

**Incidentally (the other half of the same line)**: `Context3D_submit` originally `malloc`/`free`d one
`nv*comp*8` vertex-deinterleaving temporary buffer per bound stream per frame (several MB of instantaneous
allocation per frame with large Benchmark batches). `as_s3d_upload_vertex` is a synchronous copy whose pointer
does not escape the call, so it is changed to **cached reuse** (`s3d_submit_scratch_get`: `free`+`malloc` only
if capacity is insufficient), with zero malloc/free per frame. `ASC_stage3d_pixels` (the pixel readback
buffer) is still `malloc`/`free`, since readback is an explicit call, not in the frame loop.

**Acceptance**:

- `examples/gc_bytes.as`: ① 40 rounds × 1 MB `ByteArray` churn, two rounds → after `System.gc()` the
  `totalMemoryNumber` is bounded (measured 0 / 360 B) and RSS does not grow linearly with the round count
  (`privateMemory` 1.4 → 3.6 MB, flat on the second round); ② zlib compress/uncompress buffers are
  reclaimable; ③ 40 512×512 `BitmapData`s (without `dispose`) are reclaimable; ④ reclaimable after
  `dispose()`; ⑤ live `ByteArray`/`BitmapData` across 20 rounds of "**same-size** allocation + collection"
  checked item by item (same-size is deliberate: forcing free-list reuse, otherwise a slack marker would not
  be detected).
- **Reverse comparison 1** (reverting the 9 `gc_alloc(GCT_BYTES, …)` sites to `malloc`): must FAIL —
  `FAIL: RSS did not grow by the churn size (privateMemory 1409024 → 42254336)`.
- **Reverse comparison 2** (changing `data` / `pixels`'s reflection-table entries to type 4 "scalar, do not
  follow"): must FAIL —
  `FAIL: a live ByteArray keeps its first word across collections (got 0)` (the buffer reclaimed + zeroed on
  reuse).
- `node test.ts`: 113 passed / 0 failed; `examples/stage83.as --manifest` (Metal real GPU) passes.

**Remaining (this stage's measurement corrected the earlier attribution)**: the Starling demo's per-round RSS
growth is **not** this byte-buffer leak. On the same machine and the same `temp/hidpi/cycle.py` harness,
before migration 175→206 MB (12 rounds) and after migration 175→202 MB, with **the slope unchanged**; over
the same period `ASC_GC_STATS`'s `as_big` (arena requests ≥1 MB) is **0 entries**, `leaks` is only **288 B**
(18 × 16 B), active malloc 16.7 → 17.1 MB essentially unchanged, and the GC heap flat (16 MB / 276 segments).
In other words the RSS growth comes from the **allocator's high water mark** (`vmmap`'s
`MALLOC_MEDIUM/LARGE (empty)` empty regions fluctuating by 10~60 MB, returning about once every 8~10 rounds),
not reclaimable live objects and not our byte buffers. Note that the current harness's menu click does not
land on the button (window 640×1112 while the render surface is 1800×1169, i.e. the known `csf==2` Stage3D
scaling defect), so the curve above actually **excludes** scene entry/exit — it is just the frame loop's high
water mark.

## 7. Relationship with the Existing Reflection Tables (reuse, don't rebuild)

| Existing facility | GC use |
|---|---|
| `as_prop` reflection table (`emit.ts:411` `propTypeTag`) | **Precise field enumeration** of user class instances: type 6 ref / 7 any / 3 string are references to mark; 1 number/2 bool/4 int/5 uint are values to skip |
| `as_vtable_header` super chain | mark parent-class fields along the inheritance chain (offsets are consistent under flattened struct inheritance; `offsetof` already holds) |
| `as_value` tag | decide whether an `as_value` holds a pointer (3/4/6/7) and what structure the pointer points to |
| `as_method` table | irrelevant (methods do not hold object-graph references; a closure's `env` is the root) |

---

## 8. Core Risk List

| Risk | Consequence | Mitigation |
|---|---|---|
| **Shadow Stack misses a root registration** | the object is prematurely reclaimed → a dangling pointer → **a random crash** | conservative start: register all pointer-holding locals for the whole function lifetime; exhaustive AST pre-scan; permanent roots registered separately |
| false retention | what should be reclaimed is not, leaving a leak | acceptable (safer than a crash); a liveness optimization can come later |
| a GC trigger point is not a safepoint | stack locals are reclaimed without being registered | frame-boundary safepoint (`Stage_dispatchFrame`'s `gc_step()`, when all frame callbacks have returned and only permanent roots remain) + the **conservative C stack scan** for triggers anywhere (`System.gc()`, mid-frame collection §4.2.1, the non-GUI allocation-threshold trigger §6.13) |
| **`System.gc()` triggers anywhere (non-safepoint)** | objects held only by C locals are swept → a dangling pointer → `SIGSEGV` (stage eighty-nine / twenty-two: an `Event` popped from the pool is reclaimed and then pushed back) | a **conservative stack scan** at the end of `gc_mark_roots()` (§4.2.1): `[SP, main anchor)` validates each word's object header (magic tag + in-segment address) before marking it as a root; false retention lasts only until the next collection |
| **Inexact segment-return accounting (`free_bytes` too large)** | `free_bytes == size` is no longer equivalent to "the segment is empty" → a segment **with live objects** is freed → malloc reuses that address → objects in the segment (including `gc_all`'s list head and a class instance's vtable word) become someone else's data → a random `SIGSEGV` (stage eighty-nine / twenty-seven: the crash on the second benchmark run, `gc_all` written as the double `0.9872449040412903`) | deduct allocation accounting by the block's **actual size** and after the split (§6.12), making `free_bytes` strictly equal to the sum of the free list; `ASC_GC_AUDIT` reconciles against the live-object list (`DRIFT`/`RELEASING`), with `examples/gc_seg_reap.as` as a resident regression |
| conservative stack scanning treats garbage as an object header (wrong mark / calling a garbage function pointer) | `gc_scan`'s `GCT_CUSTOM` would call garbage as the header's function pointer | all `GCT_*` are offset by `GCT_TAG_BASE`, and free/split blocks have `type=0` (no bit pattern can equal a legal tag); `gc_is_object` also requires legal color/size |
| a conservative stack scan's stack word landing at a **segment start** | the caller reads the header fields at `p - sizeof(gc_header)` falling into an unmapped page before the segment → `SIGBUS` (stage eighty-nine / twenty-four, surfacing in `stage57.as` under `-O2`) | `gc_in_heap` requires `p >= base + sizeof(gc_header)` (the first object body sits exactly there, so a legal object is not wrongly rejected) |
| the dangling pointer from `realloc`-migrating an array | `as_dict`/`as_timers` etc.'s old pointer becomes invalid on `realloc` | GC only scans pointers registered in the shadow stack/global roots; references must be updated after `realloc` (existing code already notes this) |
| **stop-the-world pause** | the triggering frame blocks the main thread, a visible stall with a large heap | safepoint triggering + threshold-controlled frequency; once the heap grows, **incremental marking** (GC-4) is required to truly eliminate it, otherwise the pause grows linearly with the heap |
| WASI lacks `getrusage` etc. | memory statistics degrade | `privateMemory` already degrades to `totalMemory` (stage fifty-two); GC is unaffected |
| **Mixing GC buffers and `malloc` buffers in the same field** | calling `free()` on a GC buffer links it into malloc's free list and wrecks GC's free list → a random crash; a `malloc` buffer is never reclaimed | single ownership: `ByteArray.data` / `BitmapData.pixels` may only be produced by `gc_alloc(GCT_BYTES)` (glue's `malloc` result is always `memcpy`ed into a GC buffer then `free`d); adding/changing these write points must also add `gc_write_barrier` (§6.14) |

---

## 9. References

- AGENTS.md §2.4 "memory management red line": no hot-path arena temporaries (once GC lands, this red line can
  be relaxed to "temporaries go through GC")
- `TODO.md` stage fifty-six (leak localization) + stage fifty-seven (this document's corresponding inception)
- AS3/AVM2 precise GC semantics reference: avmplus `GCObject` / Ruffle `gc_arena` (`Gc<'gc>`), borrowing
  semantics only, no porting
- V8 Orinoco design (trash-talk, 2019): https://v8.dev/blog/trash-talk — parallel/concurrent are not portable
  due to WASI's single-threadedness; incremental + generational ideas are borrowable (see §2.4 / §6)