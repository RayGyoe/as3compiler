# AS3 Semantic Verification Baseline

> This document is the **authoritative semantic verification checklist** consulted before implementing any
> new feature. It completes the specification sources that AGENTS.md §2.4 ("semantic red lines") depends on,
> eliminating "reverse-engineering AS3 semantics from memory or C behavior".
>
> **Before implementing any new feature, first consult the authoritative source in the table below, write the
> AS3-vs-C semantic differences into comments, and only then code.**

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
corresponding to the AGENTS.md §2.4 red-line table (status as of v0.3.67).

| AS3 semantics | Spec source | Our red line | Status |
|---------|---------|-----------|------|
| `/` is always `Number` (`int/int` is also floating-point) | ES4 draft + ECMA-262 §9 | Always promote to `double` before dividing | ✅ Implemented |
| `+` auto-boxes to string concatenation when a string is involved | ES4 draft | Go through `as_str_concat`/`as_str_from_*` | ✅ Implemented |
| String `==/!=` is value comparison | ES4 draft | `strcmp` | ✅ Implemented |
| `Number` uninitialized default = **`NaN`** | ES4 draft + AVM2 | `defaultInit`'s `number` branch outputs `NAN` | ✅ Implemented (emit.ts `defaultInit`) |
| `int`/`uint` default = `0`, `Boolean` = `false` | ES4 draft | Type immutable once inferred | ✅ Implemented |
| `String` default = `null`, reference types = `null` | ES4 draft | Handled as `null` | ✅ Implemented |
| `is`/`as` are **runtime type tests** (based on real class identity) | ES4 draft + AVM2 | RTTI via vtable `super` chain + primitive `any` tag runtime | ✅ Implemented (objects + primitives + `any`) |
| `switch` falls through natively only for `int`/`uint`; others degrade to `if/else` | ES4 draft + AS3 reference | Non-integer discriminants degrade to strict-equality chain | ✅ Implemented |
| Method closures **correctly bind `this`** (extracting `obj.method` yields a closure permanently bound to `obj`) | ES4 draft | `as_fn_make(..., __bound, (void*)obj)` binds the receiver | ✅ Implemented (emit.ts method value / closure) |
| Classes are **sealed** by default; only `dynamic class` allows expando | ES4 draft + AVM2 | Classes have a fixed shape (flattened fields + vtable) | ✅ Implemented (`dynamic` not supported) |
| Numeric coercion: `int↔uint↔Number` wrapping, `Number→int` truncation | ES4 draft + ECMA-262 §9 | `toInt32Expr`/`toUint32Expr` map to AS3 `ToInt32`/`ToUint32` | ✅ Implemented (emit.ts bitwise/coercion) |

---

## 3. Decision Divergence Points (Need Project-internal Resolution)

| Divergence | AS3 semantics | Current approach | Recommendation |
|------|---------|-----------|------|
| `var x;` (untyped, no initializer) default type | `*` (any) / `undefined` | Untyped still treated as `int` (`symbols.ts` convention); explicit `*` is modeled as `any` (`as_value` boxing) | **Keep as-is** — untyped defaults to `int` is a minimal convention; but since stage fifteen, assigning a reference type to an inferred `int` throws `CodegenError` instead of silently truncating |
| `Number` default value | `NaN` | ✅ Fixed (`defaultInit` outputs `NAN`) | No action needed |

---

## 4. Usage

1. Before implementing a new feature, consult the corresponding authoritative source in §1 to confirm the real AS3 semantics;
2. Cross-reference the §2 red-line table and write the "AS3-vs-C differences" into code comments;
3. On a §3 divergence point, first confirm the decision within the project;
4. If `AIRSDK_HOME` is available, use `$AIRSDK_HOME/bin/mxmlc` on the same `.as` input for **cross-validation** (already agreed in AGENTS.md §2.4).
