# AS3 Semantic Verification Baseline

> This document is the **authoritative semantic verification checklist** consulted before implementing any
> new feature in this compiler. It completes the specification sources that AGENTS.md §2.4 ("semantic red
> lines") depends on, eliminating "reverse-engineering AS3 semantics from memory or C behavior".
>
> **Before implementing any new feature, first consult the authoritative source in the table below, write the
> AS3-vs-C semantic differences into comments, and only then code.**
>
> Structure: §1 authoritative sources, §2 red-line quick reference, and §3 decision divergence points
> (**how to align with AIR**) form the body; §4 fidelity-and-enhancement principles and §5 pending
> enhancements supply the other half (**what counts as an enhancement beyond alignment**).

---

## 1. Authoritative Specification Sources (Tiered)

### Tier 1: Language Canon (Syntax + Type System + Semantics)

| Source | Coverage | Purpose |
|------|---------|------|
| [ES4 draft spec (2006-01)](http://archives.ecma-international.org/2006/misc/es4lang-Jan06.pdf) | Syntax, type system, name resolution, coercion semantics | **Primary reference** — the canon for AS3 syntax and type system |
| [ECMA-262 3rd Edition (ES3, 1999)](https://ecma-international.org/wp-content/uploads/ECMA-262_3rd_edition_december_1999.pdf) | The ES baseline (on which AS3 is built) | Origin of numeric conversion rules `ToInt32`/`ToNumber`/`NaN`/`Infinity` |

### Tier 2: Object Model and Runtime Semantics

| Source | Coverage | Purpose |
|------|---------|------|
| [AVM2 Overview (Adobe, 2007)](http://hackipedia.org/raw/File%20formats/Containers/F4V,%20Flash%20Video/ActionScript%20Virtual%20Machine%202%20(AVM2)%20Overview%20by%20Adobe%20(2007-05).pdf) | Object model: trait/slot, multiname, dispatch, verifier-era semantics | We borrow only the **semantics**, not the ABC bytecode |
| [avmplus source](https://github.com/adobe/avmplus) (or [adobe-flash mirror](https://github.com/adobe-flash/avmplus)) | The reference implementation's "actual behavior" | **Tie-breaker**: final arbitration when the spec is ambiguous |
| [Ruffle source](https://github.com/ruffle-rs/ruffle) (`core/src/events.rs` / `display_object/interactive.rs` / `avm2/events.rs`, etc.; local snapshot at [`as3-docs/`](as3-docs/README.md)) | Reference implementation of **event flow, hit testing, focus** for `flash.events.*` / `flash.display.*` | **GUI/event-semantics tie-breaker**: ES4/AVM2 Overview do not cover display-list event flow; in this domain Ruffle and avmplus arbitrate at the same level |

### Tier 3: Standard Library and Practical Semantics

| Source | Coverage | Purpose |
|------|---------|------|
| [AS3 Language Reference (AIR SDK)](https://airsdk.dev/reference/actionscript/3.0/) | Standard-library surface and builtin-class behavior | Already cited by AGENTS.md §2.4; this compiler's existing convention |
| [AS3 Developer Guide PDF](https://help.adobe.com/en_US/as3/dev/as3_devguide.pdf) | Builtin-class behavior, language usage | Auxiliary |
| [Apache Royale AS3 docs](https://apache.github.io/royale-docs/features/as3) | Modern, Flash-free AS3 usage | Reference for "no Flash dependency" practical semantics |

### Priority on Source Conflict

```
AGENTS.md §2.4 semantic red lines (already-decided hard rules)
  > ES4 draft  >  AVM2 Overview  >  avmplus behavior  >  AS3 reference docs
```

> For the **display-list event flow, hit testing, and focus** semantics of `flash.display.*` / `flash.events.*`,
> neither the ES4 draft nor the AVM2 Overview provides detailed coverage. In this domain, **Ruffle source and
> avmplus arbitrate at the same level** (Ruffle is the community-recognized most faithful open-source
> implementation; algorithms such as the `Avm2MousePick` three-state machine in `interactive.rs` and the
> inside-out dispatch in `handle_clip_event` are boundary semantics that documentation cannot clarify and can
> only be aligned by reading the implementation). The mapping draft is at
> [`as3-docs/mapping.md`](as3-docs/mapping.md).

This project has **no "deviate from AS3" decision layer** — the iron rule is "AS3 semantics take precedence
over C semantics"; it introduces no null-safety, generic reification, or any other deviation from AS3
semantics.

---

## 2. AS3 Semantic Decision Quick Reference (Against Red Lines)

The following are the high-risk points in AS3 semantics that "must be faithfully implemented", directly
corresponding to the AGENTS.md §2.4 red-line table (status as of v0.4.2).

| AS3 semantics | Spec source | Our red line | Status |
|---------|---------|-----------|------|
| `/` is always `Number` (`int/int` is also floating-point) | ES4 draft + ECMA-262 §9 | Always promote to `double` before dividing | ✅ Implemented |
| `%`'s **zero divisor** is defined (AVM2 `OP_remainder` does not trap): `5 % 0` yields **`NaN`** (a `Number`), while `var r:int = 5 % 0` yields **`0`** (NaN coerced to 0 on `int` receipt); `INT_MIN % -1` yields **`0`**; with a non-zero divisor `int % int` **is `int`** (`(7 % 3) is int` == true), `-7%3=-1`, `7%-3=1` | ES4 draft + AVM2; measured with adl (AIR 51.4.1, divisor taken from an array element to keep it opaque to the compiler) | `int % int` → `as_int_rem`, `uint % uint` → `as_uint_rem` (`b==0` → 0, `INT_MIN % -1` → 0); mixed/`Number` operands go through `fmod` (`fmod(x,0)` is itself NaN, matching AS3) | ✅ Implemented (stage eighty-nine / thirty-one) |
| `+` auto-boxes to string concatenation when a string is involved | ES4 draft (ToPrimitive: concatenate if either side is a String; object default hint → toString) | If either side is statically a `String`, go through `as_str_concat`/`as_str_from_*`; if either side is `any`/`null` (including `*`, array elements, dynamic properties), go through the **runtime** helper `as_add_v` (decides concat-vs-add by runtime tag, boxing the result to `any`). **Never** treat a dynamic value as a number to add — `var a:Array=["x","y"]; a[0]+a[1]` once yielded `0`, now yields `"xy"` | ✅ Implemented (stage eighty-nine / thirty-four; since stage one-hundred-twelve an **object**'s text is dispatched through the virtual `toString()`, see next row; the `Array`/`Function` boxes still use `as_v_str_val`'s simplified name, so `[Array] + 1` = `[Array]1` ≠ AS3's `1,21` — a known simplification) |
| **Object → string** always goes through the virtual `toString()`; an unoverridden one yields AIR's `[object <local class name>]` (not the C identifier) | AS3 reference `Object.toString` + adl, 12 cases compared verbatim (`temp/strprobe/`) | `as_obj_to_str` dispatches through the **vtable's `toString` slot** (the `as_vtable_header` aligns verbatim with the tail of the existing vtable, so the same reader serves both generated-class and preset-box vtables); the default `Object.toString` = `as_obj_default_str` (taking the part after `::` of the `fqn`); `as_v_str_val`'s object branch dispatches likewise; `String(x)`/`x+"b"`/`x.toString()`/array elements/Dictionary values all hit the same path | ✅ Implemented (stage one-hundred-twelve; `examples/strcoerce.as`, 12 cases verbatim-identical to adl) |
| String `==/!=` is value comparison | ES4 draft | `strcmp` | ✅ Implemented |
| `Number` uninitialized default = **`NaN`** | ES4 draft + AVM2 | `defaultInit`'s `number` branch outputs `NAN` | ✅ Implemented (emit.ts `defaultInit`) |
| `int`/`uint` default = `0`, `Boolean` = `false` | ES4 draft | Type immutable once inferred | ✅ Implemented |
| `String` default = `null`, reference types = `null` | ES4 draft | Handled as `null` | ✅ Implemented |
| **Editable-text typing is "event before edit"** (`keyDown` → `textInput` → insert → `change`), and both events are **cancelable**: canceling `keyDown` ⇒ no text is dispatched at all; canceling `textInput` ⇒ no insert and no `change`; rewriting `e.text` does **not** change the text actually inserted | AS3 reference (`TextEvent.TEXT_INPUT` is dispatched before insertion, `Event.CHANGE` after the text really changes) + `adl 51.4.1` measurement | `Stage_dispatchKey` (keyDown suppression bit `as_key_text_suppressed`) → `as_tf_insert_text` (dispatch `textInput`, check `cancelled`, truncate the insert by `maxChars`, `change`); `EventDispatcher_dispatchEvent` returns `!cancelled` | ✅ Implemented (emit.ts; evidence `temp/editprobe/`) |
| Keyboard and text are **two separate channels**: `KeyboardEvent.keyCode/charCode` is the keystroke; composed characters (non-US layout/Option/IME) go through `TextEvent.TEXT_INPUT` | AS3 reference (`KeyboardEvent` vs `TextEvent`) | The glue sends `SDL_KEYDOWN` to `on_key` and `SDL_TEXTINPUT` to the reserved `textInput` type (with `sk_window_text_take` fetching the bytes); `Stage_dispatchText` enters the same insertion path | ✅ Implemented (native); **residual**: keyDown's `charCode` is still approximated from the US base key (see `TODO.md`) |
| `is`/`as` are **runtime type tests** (based on real class identity) | ES4 draft + AVM2 | RTTI via vtable `super` chain + primitive `any` tag runtime | ✅ Implemented (objects + primitives + `any`) |
| `switch` falls through natively only for `int`/`uint`; others degrade to `if/else` | ES4 draft + AS3 reference | Non-integer discriminants degrade to strict-equality chain | ✅ Implemented |
| `a && b` / `a \|\| b` return the **value of an operand** (not a C bool), and the short-circuit pass-through operand **must not be coerced to the other side's static type** (`var r:* = (ow > 1 && c && s && s.length > 1)` with `ow=0` yields the Boolean `false` itself) | ES4 draft (§11.11/§11.12 logical-operator semantics, same as ECMA-262) + `adl 51.4.1`, **4 rounds / 26 cases** dual-end measurement (`temp/logicrepro/`, `adl-truth.txt`) | `emit.ts`'s `&&`/`\|\|` branch unifies to a concrete C type **only** for same-kind (`bool && bool` / `int && int` / `Object \|\| Object`) and numeric pairs; **if either side is `any`, both are boxed to `as_value`** (passed through verbatim, not unboxed); `bool && bool` still takes the C `&&` fast path (avoiding exponential expansion of a left-nested chain). **Never** unify `any` with a concrete type — `unifyType(any, T)` picks the **narrower** `T`, which unboxes the pass-through value plus a runtime type check, so `bool && Array` throws `#1034 cannot convert false to Array` (the guard chain at `TweenLite.as:399`, the real root cause of the air-native TweenDemo crash) | ✅ Implemented (stage one-hundred-twenty-five; `examples/logical-value.as` + unit group `logical/OperandPassThrough`) |
| **The empty string is falsy** (`Boolean("")` is false, and `("" && "hi")` yields `""`), uniformly across the whole family of condition contexts | ES4 draft (ToBoolean) + `adl 51.4.1` measurement (`temp/logicrepro/adl-truth2.txt`, `adl-truth3.txt`) | A static `String` condition goes through **`as_str_truthy(const char* s)`** (`s != NULL && s[0] != 0`), the same rule as `as_v_truthy`'s tag-3 case; covers `if`/`while`/`do-while`/`for` conditions, `!`, `?:`, `&&`/`\|\|`. The **helper takes an argument rather than inlining** (inlining mentions the operand twice ⇒ `if (f())` would call it twice). **Never** test the C `char*` for non-null directly (`""` is a non-null pointer ⇒ judged true; before the fix `("" && "hi")` yielded `"hi"`) | ✅ Implemented (stage one-hundred-twenty-five; `examples/string-truthy.as` + unit group `logical/StringTruthy`) |
| Method closures **correctly bind `this`** (extracting `obj.method` yields a closure permanently bound to `obj`) | ES4 draft | `as_fn_make(..., __bound, (void*)obj)` binds the receiver | ✅ Implemented (emit.ts method value / closure) |
| Classes are **sealed** by default; only `dynamic class` allows expando | ES4 draft + AVM2 | Classes have a fixed shape (flattened fields + vtable) | ✅ Implemented (`dynamic` not supported) |
| Numeric coercion: `int↔uint↔Number` wrapping, `Number→int` truncation; `NaN`/`±Infinity` → 0 | ES4 draft + ECMA-262 §9 | `as_to_int32`/`as_to_uint32` map to AS3 `ToInt32`/`ToUint32` (NaN/Inf → 0, avoiding the UB of the C `(int)` cast on NaN) | ✅ Implemented (emit.ts bitwise/coercion + runtime.ts helper) |
| The collection expression of `for-in`/`for-each` is **evaluated once** | ES4 draft | Emit a temporary once (`hoistCollection`), otherwise a getter re-executes and can even loop forever | ✅ Implemented (stage eighty-nine / nineteen) |
| `typeof` is a **runtime** operator reading the value's dynamic type (`var o:Object = 1` → `"number"`; a function value → `"function"`) | ES4 draft | `Object`/interface slots go through `as_ptr_typeof` (deciding by vtable), `any` goes through `as_v_typeof`; **not folded by static type** | ✅ Implemented (stage eighty-nine / nineteen) |
| `super.m` used **as a value** binds the superclass implementation (`var f:Function = super.m` is not the same as `this.m`) | ES4 draft + AVM2 | Emit a `${owner}_${mname}__superbound` thunk, casting `env` to the superclass pointer, bypassing the receiver's vtable | ✅ Implemented (stage eighty-nine / nineteen) |
| **A script has only one scope**: a `var`/`const` at any top-level position (block / `if` / `for` init / `switch` case / `try`) is a script-scope property just like a top-level declaration, a single slot per name; a closure reads the **property** (shared), not a snapshot at creation time | ES4 draft (script scope ≈ global-object properties) + AVM2 | `collectScriptDecls()` scans **the entire top-level statement tree** and hoists to C file-scope globals, serving as the single source for both `emitModuleVars` and closure `scriptVarNames`; at emit time "top-level and a module global → assign only" | ✅ Implemented (stage eighty-nine / thirty-four). Exception: the **loop variable** of a top-level `for-in`/`for-each` stays a block local (its element type is only known at emit time) |
| `hasOwnProperty`/`in` are `true` for any trait (field, accessor (getter or setter), method) declared on **this class and all superclasses** | AS3 reference (compared against `mxmlc`+`adl` measurement) | `Object_hasOwnProperty` delegates to `as_dyn_has` (which walks props/getters/methods/**setters**), ensuring the two operators never contradict | ✅ Implemented (stage eighty-nine / nineteen) |
| **Instance-member references resolve to the "nearest declaration" along the super chain** — a class's own **accessor** (getter or method) hides an ancestor's **same-named field**; a nearer **setter** governs only **writes** and does not shadow **reads** | ES4 draft (resolve along the trait chain) + AVM2 trait resolution | `src/symbols.ts`'s `shadowedForRead(cls, fieldOwner, name)` decides **layer by layer** along the super chain (down to the class declaring the field; a getter/method declared on an **intermediate** layer counts too ⇒ static types such as `Entity`/`Mesh` also work), and the five resolution points in `src/emit.ts` (3 read sites: member access `obj.p` / bare identifier `p` inside a class / `Class`-typed slot; the other 2 on the `walkInferType` inference side, making inference and emit agree) skip the **flattened** entries in `fields` on a hit. The **read side deliberately excludes setters**: builtin classes keep AIR's **accessor pairs** as **storage fields** (`DisplayObject.x/y`), so when only a nearby setter exists there is **no** ancestor getter to fall back to (which is exactly why away3d's `View3D` **reads** `x` inside the body after `override set x`). **Triggering instance**: `Intermediate_MD5Animation`'s `#1009` — `ObjectContainer3D.get parent()` was shadowed by the builtin `EventDispatcher`'s **same-named field `parent`** (the display-list ancestor link; AIR's `EventDispatcher` has no such member), and away3d never assigns that slot | ✅ Implemented (stage one-hundred-twenty-three; example `examples/member-shadow.as` + unit group `reflection/MemberShadow`) |
| Accessor properties can be **dynamically written** (`o["alpha"] = v`, `o:Object`) | AS3 reference | The vtable head carries a `setters` reflection table; `as_dyn_set` checks props then goes through setters before falling back to a dynamic slot | ✅ Implemented (stage eighty-nine / nineteen) |
| Primitive values in `Object`/interface slots (`var o:Object = 1`) must be **auto-boxed**, and unboxed when read back | ES4 draft | `as_value_to_obj`/`as_obj_to_value` in pairs; each boxed type has its own `GCT_*` marker and `gc_scan` branch | ✅ Implemented (stage eighty-nine / nineteen, including boxed `Boolean`/`Function`) |
| If AS3 defines a builtin property as an **accessor** (e.g. `ByteArray.length`), assignment must trigger the side effect (reallocation) | AS3 reference | Register in both `fields` (needed by the C struct) and `getters`/`setters`, hand-writing the getter/setter | ✅ Implemented (stage eighty-nine / nineteen) |
| Constructor arguments (including side effects) are **evaluated once** (`new XML(ba.readUTF())`) | ES4 draft | A single-evaluation C helper (`as_xml_parse_str_checked`), without temporary hoisting (which would change evaluation timing inside short-circuits/ternaries/loop conditions) | ✅ Implemented (stage eighty-nine / nineteen) |
| GC: pointers written to **freshly allocated GC blocks** (especially a growing `memcpy`) must be re-grayed | This project's GC invariant | `gc_write_barrier`/`gc_write_barrier_value`; see [`gc.md`](gc.md) §6.5.1 | ✅ Implemented (Dijkstra write barrier for stage-fifty-seven GC-4 incremental marking; `src/runtime.ts`'s `gc_write_barrier`/`gc_write_barrier_value`, design in [`gc.md`](gc.md) §6) |
| `Context3DClearMask` is a **uint bitmask** (COLOR=1/DEPTH=2/STENCIL=4/ALL=7), not a string | AS3 reference (adl measurement, `temp/refcheck/Mask.as`) | `intConstClass('Context3DClearMask', {...})`; `clear(..., mask)` ANDs bitwise | ✅ Implemented (stage eighty-nine / twenty; `intConstClass('Context3DClearMask', {COLOR:1, DEPTH:2, STENCIL:4, ALL:7})` in `src/symbols.ts`, `examples/stage81.as` asserting adl's measured values) |
| `Context3D.clear(..., depth, stencil, mask)`'s `stencil` is the **stencil clear value** (Starling uses `DEFAULT_STENCIL_VALUE=127`, not 0) | AS3 reference + Starling `Painter`/`RenderUtil` | The clear value must be forwarded layer by layer to the rendering backend (`as_s3d_clear` → `clearStencilValue`); hard-coding 0 breaks the whole scene's masking | ✅ Implemented (stage eighty-nine / twenty; both native `vendor/stage3d_glue.mm` and web `vendor/stage3d_webgl.cc` forward the clear value layer by layer — before `v0.3.116` it was hard-coded to 0, which once left Starling's `Masks` scene entirely blank) |
| Stage3D clip space is **Y-down**, opposite to Metal (Y-up) ⇒ the geometry winding is overall reversed, and `cullMode=Back` would cull the faces that should be kept | Backend adaptation (not an AS3 semantic difference, but likewise "must not be silently passed through") | `setFrontFacingWinding:MTLWindingClockwise` per draw; `FRONT_AND_BACK` ≈ Metal `None` (no culling) | ✅ Implemented (stage eighty-nine / twenty; native sets `setFrontFacingWinding:MTLWindingClockwise` per draw, web inverts clip-space Y at the GLSL vertex level + `glFrontFace(GL_CCW)`) |
| Per-draw state setters (`setDepthTest`/`setStencilActions`/`setSamplerStateAt`) are called every batch ⇒ **compare first, then mark dirty** | Performance invariant (not semantics) | Blindly rebuilding `MTLDepthStencilState`/sampler on every call = one driver-object allocation per draw, dropping rendering to unusable | ✅ Implemented (stage eighty-nine / nineteen, 8 allocation sites) |
| `DisplayObject.transform.matrix` and `x/y/rotation/scaleX/scaleY` are **two views of the same transform**: the getter **returns a copy** (mutating it does not touch the object), the setter **decomposes the matrix back into fields** | AS3 reference + `adl 51.4.1` measurement (`temp/xformcmp/Probe.as`, 25 cases; `adl` writes `/tmp/xform_adl.txt`) | Read = **synthesize a fresh `Matrix`** from the fields plus the skew residue (`Matrix_new`); write = decompose back into fields via `rotation=atan2(b,a)`, `scaleX=hypot(a,b)`, `scaleY=hypot(c,d)` (negative when `det<0`), leaving undecomposable skew in a residue slot; `X.transform.matrix = m` used **as a value** yields `m` (including chaining) | ✅ Implemented (stage eighty-nine / seventy-six). Measurement highlights: assigning `get()->rotate(30deg)` to an object at `(90,18)`, adl lands at `(68.94228634059948, 60.58845726811989)`; `[2,0.5,0.4,3,11,13]` → `rot=14.036…`, `sx=2.061…`, `sy=3.026…`; a zero matrix → `rot=0/sx=0/sy=0` and round-trips; zero-determinant and assign-as-value are both aligned. **Known divergence** (affecting only the **field-decomposition choice**; the matrix round-trip and rendering are both exact): pure flipX and "zero first column with non-zero first row" — see `TODO.md`'s leftover table (with evidence that adl contradicts itself) |

---

## 3. Decision Divergence Points (Need Project-internal Resolution)

| Divergence | AS3 semantics | Current approach | Recommendation |
|------|---------|-----------|------|
| `var x;` (untyped, no initializer) default type | `*` (any) / `undefined` | Untyped still treated as `int` (`symbols.ts` convention); explicit `*` is modeled as `any` (`as_value` boxing) | **Keep as-is** — untyped defaults to `int` is a minimal convention; but since stage fifteen, assigning a reference type to an inferred `int` throws `CodegenError` instead of silently truncating |
| `Number` default value | `NaN` | ✅ Fixed (`defaultInit` outputs `NAN`) | No action needed |
| `%` zero divisor with the result landing in a **dynamic** type use site (`var x:* = a % 0`) | `NaN` (a `Number`) | the guarded int/uint `0` (before the guard it was UB: `-O2` folds to the dividend `5`, and wasm traps) | **Keep as-is** — emitting `NaN` would require turning `int % int` into `double` wholesale, but then `7 % 3 is int` would become false (adl measures it **true**), making the static type less faithful; a zero divisor is itself an app defect, and AS3 also yields 0 at int/uint receipt sites (including `var r:int = 5 % 0`) |
| **Frame-rate contract** (presentation tick vs logical frame rate) | `Stage.frameRate` is the **logical frame rate**: `ENTER_FRAME` dispatches at that frequency and **does not follow the display refresh rate** — measured on adl in stages sixty-one/sixty-two: after moving the window to a 50 Hz external display, adl's FPS readout is still about **120** (animation speed maintained via delta time), whereas our implementation's readout drops to **50** | **Follows vsync**: native enables `SDL_RenderSetVSync(1)` so `SDL_RenderPresent` blocks until the refresh period; web paces by **whole ticks** (`skip = round(1000/frameRate / rAF period)`, presenting one frame per `skip` vsyncs, stage eighty-nine / twenty-nine). So the frame interval is always an integer multiple of the refresh period, and a `frameRate` above the refresh rate is capped to the refresh rate (stages forty-seven/sixty-one/sixty-two) | **Keep as-is** — on a 50 Hz panel this is the only physically correct approach without beat frequency (disabling vsync to chase 120 fps produces a 120-vs-50 beat, with frame intervals swinging between 8/20 ms → judder); native and web are now consistent, and **this is a presentation contract, not an AS3 semantic** (the `frameRate` read-back value, the `ENTER_FRAME` callback behavior, and delta-time-driven animation speed are all still correct). **The cap is now governed by `Stage.vsyncEnabled`** (landed in stage one-hundred-twenty-nine; AIR has this writable switch, measured default `true`): when `true`, cap as in the table; when `false`, **drop the cap** and tick at the requested `frameRate` (AIR: "the player does not wait for the display's vertical refresh") — i.e. the beat-frequency tradeoff this row could formerly only "keep as-is" is now handed back to AIR's own escape hatch. **The visible contract difference** is only in two places: (a) rates the panel cannot produce are quantized to the nearest integer fraction (on a 60 Hz panel `frameRate=24` → 20 fps; see also [`html5-web.md`](html5-web.md) §6.4); (b) the FPS readout is "presented frames" rather than adl's "`ENTER_FRAME` dispatch count". Fully aligning with adl would require decoupling the **dispatch count** from the **present count** (dispatching `ENTER_FRAME`/timers on wall-clock deadlines while still presenting once per vsync), at the cost of introducing a new semantic surface of "multiple dispatches within one frame" or "dispatch out of sync with presentation" (the `gc_step()` safepoint at the head of `Stage_dispatchFrame`, `as_timer_tick`, and dirty-rect/incremental repaint would all need re-verification) — not worth the benefit, so explicitly not done |
| **Frame dispatch under multiple windows** (the scope of `Stage.frameRate`) | `Stage.frameRate` is **one value for the entire application** (AS3 reference: changing any `Stage` affects all `Stage`s; `adl 51.4.1` measurement: after setting the main window to `4`, a newly opened `NativeWindow.stage.frameRate` also reads 4), and `ENTER_FRAME`/timers/`MovieClip` each advance once per **application frame** — **not multiplied by the number of windows** | ✅ Aligned (stage eighty-nine / seventy-three): the generated C has only one `static double ASC_app_frame_rate`, and every `Stage`'s `frameRate` accessor proxies it; `vendor/window_glue.cc`'s `sk_run_loop` runs **one application frame** per tick (one rolling deadline + one `on_frame` + marking each visible window dirty), after which each window only does its own rasterization and presentation | **No action needed** — before the fix there were two independent deviations: `NativeWindow_ctor` hard-wrote `stage.frame_rate = 24` (mistaking "the value at the time of the application" for a per-window default), and `Stage_dispatchFrame` ignored the passed-in Stage and broadcast to the process-wide `as_ef_objs` while the glue **called `on_frame` once per window** (N windows = N broadcasts; measured main 120 + 2×24 = **168**, matching the user's screenshot). Now pinned by 5 nails in `[native-window]` (31 → 36 items) |
| **The `flash.net` network-loading surface** | AIR's `URLLoader`/`URLRequest` support the `http`/`https`/`file`/`app-storage`/`app` schemes, GET/POST (any method and any request header within the application sandbox), 7 events (`complete`/`open`/`progress`/`ioError`/`httpStatus`/`httpResponseStatus`/`securityError`), `bytesLoaded`/`bytesTotal`, and a real-abort `close()`; `URLRequestMethod` has 6 constants (GET/POST/PUT/DELETE/HEAD/OPTIONS) | This project is a **local-file reader wrapped in an HTTP-API shell**: a URL is always `fopen`ed as a filesystem path (`URLLoader.load`); `URLRequest.method`/`.data`/`.contentType` are writable but **never read** (**dead fields**); the four classes `URLRequestMethod`/`URLRequestHeader`/`URLRequestDefaults`/`URLStream` **do not exist**; `open`/`httpStatus`/`httpResponseStatus`/`securityError` are **never dispatched**; `close()` is an **empty function**; `bytesLoaded`/`bytesTotal` are missing; **GET/POST are entirely absent** (measured: after setting `method="POST"` + `data`, `load()` still reads the URL as a local path) | **An explicitly recorded gap (to implement, not "keep as-is")** — **its bulk was closed in stages eighty-nine / forty-eight through fifty-three** (A/B semantic surface and contract → forty-eight; G + native probe → forty-nine; build-layer `targets` → fifty; C core + D/E/F/H → fifty-one; AIR-fidelity correction + acceptance I → fifty-two; **`Socket`/`ServerSocket`/`XMLSocket` + static self-containment + proxy/cookie/HTTP-2 → fifty-three**; still remaining are preview2 `wasi:http`, AMF, `SecureSocket` TLS, `DatagramSocket`, see `TODO.md`'s leftover table). The full official API surface, current-deviation table, 8-stage roadmap, and acceptance plan are in [`flash-net.md`](flash-net.md) (whose **§4.1.2** gives libcurl's **integration method**: zero vendoring initially, using the system library directly; for static self-containment go through `build-tools/`→`vendor/`). **A (semantic-layer completion: constant classes/fields/`decode()`) + B (contract completion: `bytesLoaded`/`open`/`close` real abort) have no network dependency and are low-risk, recommended first** (eliminating **misleading** deviations like "setting `POST` does nothing" and "`close()` is an empty function"); **C (HTTP/1.1 + TLS client) onward is an independent re-engineering effort**, whose difficulty is HTTPS/TLS and the three-target fork (native socket / web `fetch` / WASI no-socket → honest `ioError`) |
| **Where async I/O executes and when it drains** | AIR is single-threaded + frame-driven: I/O really runs **concurrently** in the background and events are dispatched as soon as they arrive; `URLLoader`/`FileStream` dispatch `PROGRESS` (possibly multiple times, with a watermark) before the terminal event; `Loader.load()` dispatches `IOErrorEvent` for both an unreadable URL and a non-image payload (#2124 "Loaded file is an unknown type"), **not** `COMPLETE`, and data/content is only visible with the terminal event (`LoaderInfo.complete` = "dispatched when data has loaded successfully"); re-`load()`ing the same target restarts the load, and the old request no longer dispatches events | **Execution location**: native (macOS/Linux pthread) uses a 4-worker pool for genuinely background read+decode (`ASC_ASYNC_THREADS`); a worker never touches the GC heap, and input is copied to malloc on submit; the web/WASI/Windows targets are **synchronously inlined** (`as_async_submit` runs in place, only deferring events). **Drain timing**: results land in a malloc staging area and are only moved into AS3-visible state at the **next frame boundary** by the finish thunk (`Stage_dispatchFrame` runs `as_async_tick()` then `as_timer_tick()`); headless `tickTimers()` = wait for workers to drain + drain all DONE at once (keeping the routines deterministic). `PROGRESS` currently fires **only once** (`loaded == total`; the read is not chunked, so there is no intermediate watermark); `LoaderInfo.PROGRESS` is still not dispatched (what Starling listens for is `URLLoader`); `LoaderInfo.bytesTotal` is non-zero only at the terminal event | **Keep as-is** — (a) frame-boundary dispatch is the closest implementation of AIR's frame-driven model, and "enter the table → do not remove the job before the thunk has run" is a GC-root invariant (removing early means sweep clears it, measured SIGSEGV); (b) the only native-vs-web difference is "does read/decode occupy the main thread", and no web worker is a given tradeoff (under wasm's single-thread model, pthread needs COOP/COEP, see [`html5-web.md`](html5-web.md)); (c) a single `PROGRESS` is a direct consequence of "the read is not chunked"; reporting a watermark would require chunked reading (N reads + per-chunk retry semantics), not worth the benefit; (d) a pure C build has no decoder (`as_skia_image_decode_bytes_argb` is a stub returning NULL) → image loading reports IO_ERROR, and the successful-decode path is covered by the skia backend (native demo acceptance). See stage eighty-nine / forty-five and `examples/async-io.as` |
| `adl` quantizes `DisplayObject.x/y` to **1/20 px (twips)** | The AS3 spec **has no such contract** (an avmplus internal storage detail): `Matrix.rotate` computes `tx=68.94228634059948`, which becomes `68.9` once it comes back through `transform.matrix =`; `ty` likewise (`60.58845726811989` → `60.55`) | Keep full precision (`x/y` is just a `double`) | **Keep as-is** — twip quantization is an implementation detail, not spec semantics; replicating it would **lower** precision and truncate all layout values pointlessly; for verification use tolerances (`x/y ±0.05`, `rotation/scale ±2e-4`) rather than comparing literals. Also: adl's decomposition intermediates go through single precision (`scaleX 1.6` → `1.5999908447265625`), likewise an internal contract |
| **Hit-test edge tightness** (a knock-on effect of twip quantization) | The AS3 spec defines a hit as "the point falling inside the object's **bounding box**", but does not define the floating-point contract for the bounding box | This implementation uses **strict geometry** (bounding box `l <= x <= r && t <= y <= b`, all `double`) | **Keep as-is, but recorded as a known difference** — a real-mouse measurement on `adl 51.4.1` (`temp/c1probe/click/`): a screen point `(310,110)` on a rotated square; adl reports `localX/localY = (14.13, -0.021)` and **judges it a hit**, whereas strict geometry puts that point **5e-5** outside the box (adl's `x/y` went through twip quantization + single-precision intermediates, see the previous row). The visible contract difference is **only within ~0.05px of the edge**: adl is looser. Replicating it would require adding an adl-magnitude tolerance to the test, and the tolerance must first be calibrated on both ends with a click probe (otherwise it turns "edge miss" into a "edge hit" false positive); examples/regressions always assert with an **interior point** (e.g. `(328,142)` → local `(49.49,9.88)`). See `TODO.md`'s leftover table |
| **AMF trait member order** | The member order in AMF3's `traits` is **unspecified** in the spec (member names and values appear in the same order and the reader pairs them by name; `describeType` also does not specify `variable` order) | This implementation uses **declaration order** (the generated `Class_amf_members[]`; deterministic and reproducible across builds) | **Keep as-is (measured and settled: no alignable target)** — the order on the `adl 51.4.1` side is **not** declaration order and is **unalignable**: ① declaring the same four members **in reverse order**, adl gives an order **verbatim identical** to the forward order (⇒ determined solely by the member-name set); ② the same SWF run three times is consistent (⇒ determined by the build artifact, not runtime randomness); ③ adding **one unreferenced class** to the source leaves the order unchanged, but adding **3 unrelated classes (referenced by `registerClassAlias`)** drifts the order of an **untouched** class `Mix` from `n1 u1 s1 o1 s2 i2 i1 b1` to `o1 n1 s1 u1 i2 b1 i1 s2`, and rebuilding from the restored source restores it (⇒ a byproduct of AVM2's internal trait/multiname table layout). Even adl itself cannot stay stable as the source evolves ⇒ **no alignable semantic target exists**; interoperability is unaffected (traits carry their member names). Evidence: `temp/a6probe/`, `examples/stage94e.as`, `test.ts` `[amforder]`. ⚠️ Hence stage ninety-four/four's "AMF3 byte-identical to `adl`" should be read as "the **encoding form of trait member names/values** is byte-identical" |

---

### 3.1 Editable Text and Keyboard (stage ninety-four · seven · C2 measurement)

The following are **AIR-internal implementation details** that the AS3 spec does not specify, but the two ends
must agree on to achieve zero cross-end difference; this implementation chooses to **replicate `adl` verbatim**
(rather than the "more reasonable" behavior). Reading it follows the same approach as §3's divergence points:
**keep as-is** or **record faithfully**.

| Divergence | Spec/intuitive behavior | `adl 51.4.1` measurement | This implementation |
|--------|--------------|------------------|--------|
| `setSelection(0, 0)` | "collapse the caret to 0" (isomorphic to `(n,n)`) | **no-op**: the existing selection is unchanged (reproduced 4/4 from four prior states) | replicated verbatim (`begin==0 && end==0` returns directly); `(3,3)`/`(0,1)` etc. take effect as usual |
| `Shift+Home` / `Shift+End` | symmetric: both "drag the selection + move the caret to the endpoint" | **asymmetric**: `Shift+Home` only drags the selection start to 0, **leaving the caret in place**; `Shift+End` extends the selection to the end of the text and **drops the caret to the end** | replicated verbatim (`as_tf_edit_key` special-cases the two separately) |
| `Shift+Delete` | equivalent to Apple's "cut" (delete the selection and write the clipboard) | **does nothing at all**: keyDown is **not dispatched**, text and selection unchanged (the paired keyUp is still dispatched) | replicated verbatim: swallow that keyDown when the input field has focus |
| `keyUp` under a menu accelerator | `Cmd+←/→/Z` are ordinary keys, so down/up should pair up | keyDown for letter/arrow keys does arrive (`ctrlKey=true`, and the caret really moves), but their **keyUp does not**; Cmd's own keyUp does arrive | replicated verbatim: under `mod & ASC_MOD_CMD`, the keyUp of any non-modifier key is swallowed |
| `new TextField().text` | returns `null` when unset | the **empty string** `""` (`.length == 0`) | give it an empty string at construction (giving C `NULL` would make `text == ""` false and dereference a null pointer for `.text.length`) |
| `new TextField().tabEnabled` | unrelated to editability, default `false` | follows `(type == "input")` only when `type` **really changes**; re-assigning the same value **does not touch** a manually changed value | default `false` (the original `true` was a misreading — the `true` in the probe came from the probe itself setting `type=INPUT`); and `type`'s **setter** replicates the linkage (writes `tabEnabled` only when the value really changes; re-assigning the same value does not overwrite a manual value) |

**Recorded approximations/gaps** (evidence and fix per item in `TODO.md`'s leftover table): the edit index is
by **UTF-8 byte** (AIR uses UTF-16 code units), `Tab`/`Shift+Tab` **do not do focus traversal** (the sole
unaligned point in the whole Ed2 round), `PageUp`/`PageDown` only dispatch without moving the caret, the
visible row/column for `Up`/`Down` under `wordWrap`, the IME composing state (marked text),
`restrict`/`displayAsPassword` are stored but inert, `MouseEvent.DOUBLE_CLICK` is never dispatched
(double-click word selection goes through an engine-internal reserved channel and does not produce a
`MouseEvent`). ⚠️ This section once had a **misjudgment**: C2 at the time wrote "mouse drag-selection only
works when `type='input'`" into the measured contract, but that was concluded after **only one synthetic
drag**; stage ninety-four/eight **overturned** it with a per-event probe (`Ed5`) — see §3.2 below.

---

### 3.2 Text Border and Mouse Selection (stage ninety-four · eight measurement)

Likewise an implementation detail that the spec does not specify but the two ends must agree on. **The key
point is a correction to one contract**: AIR judges "pressing inside a selection" not by "the closed interval
between character gaps", but by the **pixel highlight rectangle** — the highlight covers the pixels
`[x(begin), x(end))`, with the left edge inside and the right edge outside. In index terms this is the
**half-open interval** `[begin, end)`.

| Divergence | Spec/intuitive behavior | `adl 51.4.1` measurement | This implementation |
|--------|--------------|------------------|--------|
| Drag-selection gating | "only a truly editable field can have a selection" (C2 once allowed only `type='input'` on this basis) | a `dynamic + selectable=true` field **also** supports drag-selection, and after `mouseUp` `Cmd+C` can copy the selected text away | gating is only `selectable`; **typing** is still restricted to `input` (`as_tf_is_input`) |
| Drag anchor | anchor = the character where the drag started; the selection extends with the drag | `mouseDown` **collapses** the caret to the hit index and sets it as the anchor; during the drag `begin=min(anchor,idx)`/`end=max(anchor,idx)`/`caret=end` (forward and backward give the **same** selection) | replicated verbatim |
| "Pressing inside an existing selection" | judged by character gaps, both ends closed | by the **pixel highlight rectangle**: `idx >= begin && idx < end` (**left edge kept, right edge collapsed**, locked case by case in Ed5 steps 8/11a/13b/13c) | replicated verbatim (half-open interval) |
| Order of double-click word selection vs "pressing inside a selection" | if a double-click lands inside an existing selection, collapsing first and then selecting the word is harmless | the second `mouseDown` of a double-click goes through the "pressing inside a selection" branch first, and unless the pending-collapse state is disabled, the following `mouseUp` collapses **the word just selected** | clear the pending-collapse state when the reserved channel `wordSelect` bridges (`drag_tf`/`drag_anchor` promoted to file-scope statics) |
| `border` default / geometry | "a 1px border is drawn inside the box" (common UI intuition) | default `false`; four 1px fully opaque **non-antialiased** solid lines fall on the field box's **outer edge pixels** (`x∈{0,width}`, `y∈{0,height}`), so the `BitmapData.draw` source surface is `width+1 × height+1` | replicated verbatim: four **pixel-aligned filled rectangles** (not `stroke`, which would half-cover the outer edge pixels), with `as_render_bounds`/`draw` synced to +1; does not affect `textWidth`/`textHeight` |
| Bit width of the color properties | "`uint` is 32 bits, alpha should be preserved" (this implementation did not mask before C2) | all three color properties (`backgroundColor`/`textColor`/`borderColor`) are **24-bit RGB**: writing **discards the alpha byte**, which is also invisible on read-back (`0x8000FF00` → `0xff00`, `0xFFFFFFFF` → `0xffffff`) | write-mask `& 0xFFFFFFu` (rendering already uses a separate alpha argument, so only read-back is affected) |

**Recorded approximations/gaps**: with `scale != 1`, the border line width **scales with the object** (adl is
always 1 physical px; at `scale=1` the two ends are identical); the caret-position metric difference (adl
21/26 vs ours 18/23) is the same source as §3.1's font-metrics row. Evidence and fix per item in `TODO.md`'s
leftover table.

---

## 4. Fidelity and Enhancement Principles

§2's red lines and §3's divergence points both answer "**how to align with AIR**". This section supplies the
other half: **beyond alignment, what counts as an "enhancement"**.

1. **Fidelity is the bottom line (non-negotiable).** AIR-defined semantics must be aligned **verbatim** —
   error numbers, error text, event order and count, boundary values, API shape, all per `adl` measurement.
   An enhancement **must not** rewrite any AIR-defined behavior: whatever the same `.as` is under `adl`, it
   must be the same in our output.
2. **An enhancement is a gain (whitelisted, must be argued).** An enhancement is allowed only when AIR
   **does not define / explicitly does not support / has no counterpart** it, and it **must be opt-in**; a
   default output that declares no switch stays isomorphic to AIR.

**The criterion (very useful, and very hard)**: for the same input, if `adl` produces a correct result and we
cannot → that is a **legacy defect** (goes into `TODO.md`'s `### 遗留待开发`); if `adl` **itself errors** on
the same input, or the API does not exist in AIR at all → only then does our building it count as an
**enhancement** (goes into `### 增强待做`).

Example: `Loader.load("*.svg")` on `adl 51.4.1` is measured to be `Error #2124: Loaded file is an unknown
type.` — AIR's `Loader` spec is consistent in three places that only SWF / JPG / PNG / GIF are supported,
**SVG is never in scope**. So "supporting SVG" is an **enhancement**, not closing a gap.

**The five criteria for an enhancement** (falls outside AIR semantics, never silent, cross-end differences
explicitly listed, opt-in without bloating the default output, passes DoD — each with counterexamples) are in
[`enhancements.md`](enhancements.md) §1.2. **Why an enhancement is worth it here** (linking the mature
ecosystem, reaping compiler benefits, interop with the host C, stepping beyond browser/desktop) is in the
same document's §1.3.

**An easy-to-misjudge "looks like an enhancement but isn't"**: `--air-app`'s **compile surface** (stage
one-hundred-twenty-four). It used to compile every `.as` under `src/`, and now narrows the surface to the
**transitive closure of the main class** (`src/reach.ts`) — this is **not** an enhancement but **stopping
over-approximating AIR**: `mxmlc`/`adl` already link only the transitive closure reachable from the document
class (`-link-report` measured away3d's six demos at 158–246 defs each, while 198 of the 485 files are
touched by no demo). The criterion is still the one above, just in the opposite direction: `adl` never packs
those resources and never errors on a bad `[Embed]` in an unreachable class, whereas **we previously did** ⇒
narrowing the surface is **fixing an over-approximation**. Making the output range **exceed** AIR (e.g.
forcing the whole tree to be compiled in) is what needs a named switch like `--all-sources`.

**Another easy-to-misjudge "looks like new semantics but isn't"**: `&&`/`||`'s **operand pass-through** and
**empty-string-falsy** (stage one-hundred-twenty-five). Both are AIR/ES3 **already-defined** behaviors that we
previously translated wrongly (`bool && Array` unboxed the pass-through value and threw `#1034`; a static
`String` condition used a non-null `char*` test, judging `""` true) — by this section's criterion, this is a
**legacy defect fixed correctly**, neither an enhancement nor a newly added gap. The mnemonic: **anything
`adl` can produce a result for while we cannot is treated as a legacy issue first**, and only when `adl`
itself errors or the API does not exist in AIR at all does it enter §5's enhancement list.

## 5. Pending Enhancements (beyond AIR)

Each item below satisfies the premise "AIR does not define / does not support" it, being a **gain** rather
than a debt; the list itself contains no rewrite of any AIR semantics. Full motivation, dependencies, cost,
target ends, and per-item description are in [`enhancements.md`](enhancements.md) §3/§4.

| Enhancement | AIR status | Target ends | Cost |
|--------|---------|--------|------|
| SVG runtime decoding (`Loader.load("*.svg")`) | ✗ never supported (measured `#2124`) | native: library already built + linked, missing glue; web: needs Skia rebuilt with expat | medium |
| Lottie vector animation (Skottie) | ✗ no counterpart | native: library already built + linked, missing player API; web: needs rebuild | medium |
| WebP / BMP / ICO and other format decoding | partial (only JPG/PNG/GIF) | both ends (`SkCodec` already compiled in, **to be measured**) | low |
| Camera RAW / DNG decoding | ✗ | native: `libpiex`/`libdng_sdk` already built; web: needs rebuild | low-medium |
| Raw shader passthrough (MSL / GLSL ES) | ✗ (only AGAL) | both ends | medium |
| FFI: directly calling host C functions | ✗ | native (the unique gain of "direct-to-C") | medium |
| LTO / PGO build switches | — | both ends | low |

(The table above is an excerpt; the full list in `enhancements.md` §3 is **15 items**, also covering vector
graphics on-screen, general-purpose GPU compute, windowless/server-side rendering, 64-bit integers,
`Vector.<Number>` SIMD, truly-concurrent `Worker`, frame recording/deterministic replay, and readable C as a
first-class deliverable.)

---

## 6. Usage

1. Before implementing a new feature, consult the corresponding authoritative source in §1 to confirm the real AS3 semantics;
2. Cross-reference the §2 red-line table and write the "AS3-vs-C differences" into code comments;
3. On a §3 divergence point, first confirm the decision within the project;
4. Before an enhancement beyond AIR, first pass §4's two principles + [`enhancements.md`](enhancements.md) §1.2's five criteria
   (especially "falls outside AIR semantics" and "opt-in without bloating the default output");
5. If `AIRSDK_HOME` is available, use `$AIRSDK_HOME/bin/mxmlc` on the same `.as` input for **cross-validation** (already agreed in AGENTS.md §2.4).