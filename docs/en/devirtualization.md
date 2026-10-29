# Devirtualization of virtual dispatch (direct calls for leaf classes and `final`)

> This is the design and implementation record for replacing AS3 instance-member
> calls that provably need no dynamic dispatch with direct calls instead of
> `->vtable->` indirect calls. **Phase A (ordinary methods on leaf classes) landed
> in stage 321 / v0.4.282**; accessors, `final`, and private members remain future
> phases. The document distinguishes static call sites from dynamic execution counts,
> and leaf classes, `final`, private members, and genuinely polymorphic paths from
> one another. Every safety claim is based on the current complete compilation set
> and measured `mxmlc`/`adl` behavior, never inferred from AIR SDK metadata or names.

---

## 1. Background and positioning: devirtualization is "form transformation", not "frontend optimization"

AGENTS.md §1.1 is ironclad: the frontend does no semantic optimization (no peephole,
constant folding, DCE, register allocation, or inlining) — those are `cc/clang -O2`'s
job. But §1.4 authorizes one kind of **form transformation**:

> "…statically-known types skip dynamic dispatch … use native `int` arithmetic at the
> C level instead of boxing into `double` whenever possible."

Devirtualization belongs here: when the type and inheritance relationships are
**provable**, it replaces `obj->vtable->foo(obj)` with a direct call to the resolved
implementation, such as `Base_foo(obj)`. The transformation must not change member
resolution, receiver/argument evaluation, exceptions, or any other observable behavior;
subsequent optimization such as inlining and constant propagation remains `-O2`'s job.
It is therefore translation form, not an out-of-bounds hand-written optimization pass.

It has the same nature as the size optimization (`docs/zh-cn/size-optimization.md`):
there, method bodies are marked `static` so `-O2` can prune the call graph; here,
provable call sites become direct calls so `-O2` can decide whether to inline them.

**The leaf-class proof is not a permanent AS3-spec guarantee for arbitrary future
source.** It is a closed-world fact: the class has no subclasses among all classes in
this complete compilation. Runtime ABC loading, separate modules, or external subclass
injection would require this premise to be revisited (§7, §8).

---

## 2. Status quo: the main statically typed instance-member paths always dispatch virtually

### 2.1 The method-body carrier must exist (cannot be removed)

Every AS3 method/accessor implementation has a translated C function as its carrier,
for example:

```c
double Sprite_get_width(void* _this);
void   Sprite_set_width(void* _this, double value);
```

This is the carrier required by the §2.6 naming convention (`Foo_method(Foo* this)`
maps back to the AS source entity) and the skeleton of "readable C". Devirtualization
changes call sites only; it **does not remove or expand method bodies**.

### 2.2 Ordinary paths with statically known class receivers use the vtable

For the main resolved paths of **ordinary instance methods and accessors whose static
receiver types are known**, the emitter currently uses class-vtable dispatch without
distinguishing whether the member can be overridden, for example (line numbers describe
the current source and may drift):

```c
(obj->vtable->set_foo(obj, v))   // src/emit.ts:2609
(obj->vtable->foo(obj, args))    // src/emit.ts:31185, 34555, 34583
(self->vtable->get_foo(self))    // src/emit.ts:32610, 34507, 35388
```

The emission-site comments explain the default virtual dispatch
(`src/emit.ts:2603`, `32607`): subclasses may override, so a reference whose static
type is a base class must reach the runtime implementation.

But "the main static paths" does not mean "every instance-member expression". Other
dispatch forms already exist:

- `super.method()` already calls the parent implementation directly
  (`src/emit.ts:36784-36786`);
- static methods and static setters already use direct calls;
- `Object` method calls use `as_dyn_call`, and property reads use `as_dyn_get`
  (`src/emit.ts:34451-34468`, `35302-35315`); `*` uses `emitAnyMethod` and other
  dynamic paths;
- interface calls use a separate `{obj, vt}` interface table, not the class `vtable`;
- method-value thunks still fetch implementations through the vtable
  (`src/emit.ts:7533-7539`);
- private members have their own visibility and binding rules and cannot be described
  by the same public/protected rule.

After phase A, `instanceMethodCallCode()` selects the form for the ordinary-method
paths above: a statically leaf-typed receiver in the closed compilation set calls the
`m.owner` implementation directly, while other receivers retain vtable dispatch.
Explicit `obj.method()`, implicit `this.method()`, and sealed-`with` calls resolved
to the same ordinary method are covered; method-value bound thunks are unchanged.
Dynamic, interface, `super`, static, Proxy, private, and accessor paths remain unchanged.

---

## 3. Current use of `final` and the validation gap

The `final` modifier is already parsed and entered into the symbol tables:

- method-level `MethodInfo.isFinal`;
- class-level `ClassInfo.isFinal`;
- the parser consumes the `final` modifier (`src/parser.ts:327-335`, `361-365`).

Current consumers are:

| Consumer | Purpose and boundary |
|---|---|
| `src/symbols.ts:8606` | a `final` class cannot be inherited |
| `src/symbols.ts:8651-8658` | compile-time override checking for **ordinary methods** marked `final` |
| `src/emit.ts:1687`, `2632-2633`, `4353-4677` | `isFinal` reflection data for `describeType` |

Neither ordinary-method nor accessor dispatch uses `isFinal`. There is also a
prerequisite gap that must be recorded: `src/symbols.ts:8651-8658` checks only
`methods`; the subsequent getter/setter merge has **no corresponding final-override
check**. It is therefore incorrect to claim broadly that the compiler already
guarantees that no final member can be overridden.

The conclusion has two parts:

1. Leaf-class devirtualization does not depend on `final` and can be evaluated and
   implemented independently.
2. `final` ordinary-method devirtualization can build on the existing checks, but
   `final` getters/setters need override validation and negative tests before their
   `isFinal` bit may be treated as a safety proof.

---

## 4. Real-world static inventory (TalkMED Meeting desktop)

> 2026-10-30: class-inheritance graph and `->vtable->` text scan over a 402,883-line /
> 29 MB generated C file. These figures describe **the static structure of that
> snapshot**, not a runtime profile, and cannot be converted directly into a
> devirtualization percentage.

| Metric | Value and scope |
|---|---|
| Generated C size | 402,883 lines / 29 MB |
| Total classes (vtables) | 1,545 |
| Classes with a parent | 1,083 |
| Classes with subclasses | 90 (5.8%) |
| Leaf classes without subclasses | 1,455 (94.2%) |
| Total `->vtable->` textual occurrences | 22,291 (including non-call uses such as taking `->vtable`) |
| Call-shaped `->vtable->name(` occurrences | 18,707 (counted by occurrence, not by line) |
| Getter/setter textual dispatches | 8,626 (39%, older text-scan scope) |
| `this/self->vtable->` self-dispatch in the whole file | 7,774 |

The 7,774 figure is the **whole-file self-dispatch total**, not the subset inside leaf
class bodies. The current scan does not annotate each call site with its receiver
static type, resolved member owner, and leaf/final state.

The inheritance-depth distribution is
`{"0":462,"1":370,"2":256,"3":109,"4":29,"5":11,"6":14,"7":251,…}`.
The member names with the highest static textual occurrence counts are:

```text
get_stage(1753)  addEventListener(1112)  removeEventListener(613)
addChild(568)    dispatchEvent(482)      get_parent(297)
```

These are **static call-site frequencies**, not runtime hotspots. Nor can they all be
classified as "genuinely polymorphic" by name: that requires checking the receiver
type, resolved member, and inheritance chain for actual overrides.

"94.2% of classes are leaves" also does not mean "94.2% of methods or call sites can
be devirtualized": class share, member share, static call-site share, and dynamic
execution share are four different metrics.

### 4.1 Measured call-site classification (2026-10-30, probe `temp/devirt-measure.cjs`)

A further measurement ran over the same C snapshot: parsing each `struct Foo_vtable`
slot layout together with each `static Foo_vtable Foo_vt = {…}` initializer yields an
exact "class → slot → implementing function" mapping, against which all 18,707
call-shaped occurrences were classified. 1,078 classes with complete initializers
were parsed (out of 1,103 vtable layouts; the rest are pre-baked builtins and other
forms without a matching initializer), 989 of them leaf classes.

| Category | Call sites | Share of 18,707 | Proof |
|---|---|---|---|
| Slot has a **single implementation** program-wide | 6,864 | 36.7% | Receiver-independent: every class vtable dispatches that slot to the same function, so a direct call is safe |
| **`this` self-dispatch inside leaf-class bodies** | 6,710 | 35.9% | In the closed world, `this` can only be that leaf class; direct-call the implementation resolved in its own vtable |
| **Union of the two** | **13,574** | **72.6%** | Call sites already covered by two cheap static proofs |

Additional scope notes: 922 self-dispatch sites sit inside non-leaf class bodies, and
548 sit in free functions/closures that could not be attributed to a class by function
name. All 6,710 leaf-class self-dispatch sites resolve to an implementing function in
their own vtable initializer.

The multi-implementation slots with the highest static occurrence counts (these still
need receiver-type/final analysis or must stay virtual):

```text
get_stage(1753 sites/6 impls)  addEventListener(931/8)  removeEventListener(527/6)
addChild(451/4)                dispatchEvent(386/5)     get_height(198/27)
get_width(186/26)              dispose(149/83)
```

Three boundaries govern how these numbers may be read:

1. This is **static call-site coverage**, not a dynamic execution share, and certainly
   not a speedup;
2. 72.6% is not a theoretical upper bound — it excludes further opportunities such as
   external calls with statically leaf-typed receivers, `final`, and private members;
   it is merely the union of the two cheapest proofs;
3. It comes from structured parsing of generated C (the slot→implementation mapping is
   exact), not from name-based guessing; implementation should still redo the same
   classification at the semantic-emission layer (§9.4), keyed by receiver static type.

### 4.2 Same-HEAD comparison after phase A (2026-10-30)

The same TalkMED source, macOS descriptor, SWC, and compiler options were built with
plain HEAD and with HEAD plus the phase-A patch. Both generated C files have 408,776
lines, so the reduction below is isolated from application-source and old-compiler
snapshot drift.

| Metric | HEAD baseline | Phase A | Change |
|---|---:|---:|---:|
| Call-shaped `->vtable->name(` occurrences | 18,707 | 12,129 | **-6,578 (-35.2%)** |
| All `->vtable->` textual occurrences | 22,291 | 15,713 | -6,578 |
| Generated C bytes | 30,614,788 | 30,370,810 | -243,978 (-0.80%) |
| Native binary bytes | 23,343,536 | 23,343,520 | -16 (approximately 0%) |
| One complete build, wall time | 97.20 s | 91.35 s | Single reading; no performance claim |

Phase A's 35.2% is intentionally lower than the 72.6% opportunity union in §4.1:
the former implements ordinary methods only, while the latter includes accessors
and additional proofs not yet implemented. The scopes differ, so this neither means
"half the opportunity was delivered" nor predicts a runtime gain.

---

## 5. Devirtualization opportunities and retention boundaries

### 5.1 Leaf-class receivers: the main first-phase candidate

If the receiver's static class `C` has no subclasses in the complete compilation set,
the runtime object can only be `C` (apart from `null`, whose guards and exception
behavior stay unchanged). For an ordinary member already resolved by nearest-wins
lookup on `C`'s inheritance chain, the resolved implementation can be called directly
without going through the vtable.

For example, if `Leaf extends Base` and does not override `Base.foo`:

```as3
var x:Leaf = ...;
x.foo();
```

this can be devirtualized to `Base_foo(x)`, **not** to an invented `Leaf_foo(x)`.
"Leaf class" only proves that a direct call is possible; the function to call is still
determined by the existing resolution result's `m.owner` / `g.owner` / `s.owner`.

This opportunity needs no `final`. The class graph requires only one O(number of
classes) symbol-table traversal, but it must cover builtin classes, user classes, and
SWC/Embed-synthesized classes in the actual compilation, not just scan a source folder.

### 5.2 `final` and private: validate separately; do not reuse unverified examples

`final` ordinary methods, `final` classes, and leaf classes can all provide static
proofs, but the proof sources and validation coverage differ. In particular, `width`,
`height`, `parent`, `numChildren`, and `stage` must no longer be used as examples of
"AIR final getters": on 2026-10-30, a probe compiled with local mxmlc 51.4.1
(`temp/devirtualization-review/FinalProbe.as`) showed that **all five getters permit
overrides**. Existing builtin implementation records also include TextField/Video
overrides of width/height.

Builtin `isFinal` values cannot be copied from SDK metadata.
`src/symbols.ts:3548-3554` already records a counter-example: the AIR SDK reports
`FileReference` as final, but mxmlc 51.4.1 measurably permits inheritance, and this
project itself has `File extends FileReference`. Every final annotation must be based
on whether mxmlc actually rejects inheritance/override, with positive and negative
tests retained.

Private members are another static-binding candidate worth evaluating separately,
because they do not participate in ordinary public/protected inheritance polymorphism.
They must nevertheless be implemented and accepted according to declaring owner,
namespace, and visibility rules; they cannot simply be folded into phase one or
described as "currently always vtable-dispatched".

### 5.3 Dispatch must remain when safety cannot be proven

Keep the existing path for:

- a receiver whose static type is not a leaf class, when the resolved member lacks a
  sufficient, validated final/static-binding proof;
- base-typed references that must reach subclass overrides;
- `*`, `Object`, interface, Proxy, and other dynamic dispatch paths;
- any rewrite that would change member resolution, exceptions, evaluation order, or
  single evaluation.

"Keep the vtable" does not mean the member has been proven polymorphic at runtime; it
only means the compiler currently lacks enough proof for a safe direct call. A future
whole-program override-set analysis should be separately designed and measured rather
than silently added to phase one.

---

## 6. Performance gain: static and scoped A/B measurements show no stable speedup

### 6.1 Direct calls save a little; backend optimization may amplify it

Turning `->vtable->foo(obj)` into a direct call can save one vtable load and one
indirect jump. The larger potential benefit is that `-O2` can see the direct call and
decide for itself whether to inline it and apply further data-flow optimization. These
gains must be measured with an A/B run of the same application, input, and compiler
options; they cannot be inferred from the generated C's shape.

Direct calls may also increase code size or compilation time by enabling inlining, so
binary size and build time are acceptance metrics too, not just runtime speed.

### 6.2 Static call-site coverage measured at 72.6%, but it is not a speedup

The previous claim that "60–80% / 13K–18K call sites can be eliminated" had no
classification data behind it and was withdrawn. The §4.1 measurement now provides an
evidence-based static figure: the union of two provably safe analyses (unique-
implementation slots plus leaf-class self-dispatch) covers **13,574 / 18,707 = 72.6%**
of the application's static call sites. The old estimate landing near the measured
number is a coincidence; the measured figure is the authoritative one.

Static coverage is not a benefit: **the dynamic execution share remains unmeasured**.
A polymorphic slot set representing only 30% of static sites could easily account for
the majority of runtime calls (`get_stage` and `addEventListener`, for example, both
sit in the multi-implementation bucket). The scoped phase-A A/B appears in §6.3 and
must not be extrapolated to the whole application.

Implementation should redo the classification at the emitter or an equivalent
semantic-analysis layer, recording "receiver static type + resolved member owner +
leaf/final state", and cross-check it against the C-level measurement in §4.1.

Devirtualization is a steady-state throughput optimization and does not automatically
supersede existing investigations such as `gc_find_block()` or fixed per-frame cost.
Implementation order should follow the latest TODO and controlled measurements, not a
static call-site coverage percentage.

### 6.3 CPU A/B during launch plus 15 idle seconds on the login window

The two same-HEAD binaries from §4.2 ran in alternating order for three rounds each.
Each round launched the application, left its window idle for 15 seconds, and recorded
process user+sys CPU. Both arms completed startup and stayed alive. Application-owned
network requests and responses were not identical between runs, so this is a scoped
scenario, not a deterministic compute benchmark.

| Arm | Three CPU readings (seconds) | Mean |
|---|---|---:|
| HEAD baseline | 1.321961 / 1.242744 / 1.245939 | 1.270215 |
| Phase A | 1.342204 / 1.285500 / 1.292283 | 1.306662 |

The phase-A sample mean is about 2.9% higher, with run-to-run variation: **no speedup
can be claimed**, nor do these data establish a general performance regression. The
conclusion is limited to this machine, login window, and idle scenario. Further work
should use a network-free, fixed-input, repeatable call/render benchmark and report a
multi-run distribution instead of converting 35.2% static elimination into speed.

---

## 7. Implementation design and phases

### 7.1 Shared prerequisites

1. After symbol collection for the complete compilation set, compute `hasSubclasses`
   from the `superClass` links. This is one O(number of classes) traversal, with no
   additional whole-AST scan.
2. The compilation set must include builtin classes, actually included user classes,
   and SWC/Embed-synthesized classes. `--air-app` uses the real emitted class set after
   pruning, not every `.as` file on disk.
3. A direct-call decision needs at least the receiver's static class and the member
   owner produced by nearest-wins resolution; the target must be the owner's
   implementation function.
4. Preserve existing null guards such as `as_req_obj`, receiver/argument evaluation
   order, single evaluation, and exception behavior. Devirtualization must not become
   a textual substitution that evaluates the receiver more than once.

### 7.2 Recommended phases

- **Phase A (minimum safe slice, implemented)**: handle only **ordinary method calls**
  whose statically known receiver is a leaf class, including explicit calls, implicit
  `this`, and sealed `with`. Leave dynamic, interface, `super`, static, Proxy, private,
  accessor, and method-value bound-thunk paths unchanged.
- **Phase B (accessor coverage)**: after behavioral fixtures are in place, extend to
  leaf-class getters/setters and cover ordinary reads, call-after-read, compound
  assignment, `||=`, `++/--`, and related paths. Helpers such as `setterCallCode()`
  that lack the receiver static type must receive that context explicitly; changing a
  returned string alone is insufficient.
- **Phase C (independent proofs)**: evaluate `final` ordinary methods, `final`
  classes, and private static binding separately. `final` getters/setters require
  compile-time override validation and negative tests before devirtualization.

Method-value bound thunks, implicit `this.method()`, and other entry points must also
be inventoried, with an explicit coverage decision for each phase. Uncovered entry
points keep their current behavior; changing only the main path does not justify the
claim that "all instance calls are devirtualized".

The implementation is concentrated in `src/emit.ts`: one O(number-of-classes) pass
after symbol collection computes `leafClasses`, and three ordinary-method entry points
share `instanceMethodCallCode()`. Lexer/parser and hand-written optimization passes
are untouched.

---

## 8. Risk boundary

| Case | Handling | Basis |
|---|---|---|
| Static receiver is a leaf in the current compilation set; member is resolved | Direct-call the resolved owner's implementation | No subclass exists in the closed world, so the runtime type cannot be further derived |
| `final` ordinary method | Evaluate separately later | Existing ordinary-method override checks can provide the proof |
| `final` getter/setter | Do not direct-call from `isFinal` alone before validation is added | Accessor final-override checks are currently missing |
| `final` class | Independent proof, or covered by the class graph | Still requires a closed compilation set and effective final-inheritance validation |
| Base-typed reference requiring polymorphism | Keep the vtable | Must reach the runtime override |
| `*` / `Object` / dynamic receiver | Keep `as_dyn_*` / `emitAnyMethod` and related paths | Not "box + vtable", and outside phase one |
| Interface receiver | Keep the separate interface-table dispatch | Does not use the class vtable |
| `super` / static | Keep existing direct calls | This design does not change their binding |
| private / Proxy | Keep current paths; design separately | Visibility and dynamic hooks cannot use the ordinary rules |

This design performs no speculative devirtualization such as "bet it is probably this
class". Every direct call needs an explicit static proof and behavioral differential
validation. Any future feature that breaks the closed-world premise (runtime ABC,
external-module subclasses, and so on) is a boundary requiring this design to be
revisited.

---

## 9. Acceptance criteria

1. **Behavioral fixtures + `adl` differential testing**: add examples covering leaf
   inheritance, implementations declared on ancestor owners, base-typed references,
   real overrides, getters/setters, `super`, interfaces, dynamic receivers, and Proxy;
   compare output, exceptions, and evaluation counts item by item. Checking that the
   generated C merely "looks direct" is insufficient.
2. **Structural pins**: in `test/unit/`, separately assert that a leaf ordinary method
   calls the correct owner directly, a polymorphic base call still uses the vtable,
   and dynamic/interface/`super` paths remain unchanged. Later phases add independent
   pins and negative tests for accessors and final.
3. **Full regression**: `node test.ts` is fully green. During development run only the
   relevant local groups; run the full suite at completion as required by project
   policy.
4. **Static quantification**: at the semantic-emission layer, count direct-callable /
   must-retain / out-of-scope sites and report static call sites; do not infer a
   percentage from leaf-class share or member names.
5. **Dynamic performance A/B**: with the same real application, input, backend, and
   compiler options, compare before/after runtime profiles and end-to-end metrics.
   Static textual frequency is not a dynamic hotspot profile.
6. **Non-performance regressions**: record generated-C/binary size and compilation
   time as well. If direct calls enable inlining that causes a significant regression,
   report it honestly and reassess the benefit.

---

## 10. Boundaries and non-goals

- **No hand-written inlining**: change only the call form and let `-O2` decide whether
  to inline; do not expand method bodies.
- **No `__attribute__` / inline assembly**: a direct call is an ordinary C call with
  no platform coupling.
- **No speculative devirtualization**: do not profile-guess a concrete type; use only
  provable information.
- **No changes to dynamic/interface/`super`/static/Proxy semantics**: paths outside
  the current phase stay unchanged.
- **Do not mix private members or final accessors into phase one**: each has its own
  validation and acceptance prerequisites.
- **Do not change GC / boxing / the allocator**: these are independent performance
  topics and must not be combined with devirtualization in one change.
- **No preset performance figures**: promise no call-site elimination percentage or
  speedup before measurement.

---

**One-line conclusion**: phase A now direct-calls owner implementations for ordinary
methods on leaf receivers, eliminating 6,578 / 18,707 (35.2%) of call-shaped vtable
sites in a same-HEAD real-application comparison. Dynamic, interface, accessor, and
bound-thunk boundaries remain unchanged. The scoped idle A/B showed no stable speedup,
so static coverage is not presented as a performance gain; accessors, `final`, and
private remain separate later phases.
