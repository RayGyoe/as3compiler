# Size Optimization for Generated C / Binaries (Static-ization + `-O2` Automatic Tree-Shaking)

> This document records the root cause of as3compiler's output size and the final landed approach of "marking
> all builtin-class method bodies `static`, letting `clang -O2` build a call graph from `main` and automatically
> eliminate unreachable symbols". The approach is implemented in `staticizeTopLevelFunctions()` in
> `src/emit.ts` (stage seventy-eight).

---

## 1. Measured Baseline (`examples/hello.as`, ~500 B, pure `trace`)

| Metric | Before static-ization | After static-ization |
|---|---|---|
| Generated `examples/hello.c` | 378 KB / 8924 lines | 378 KB / 8924 lines (only `static` prefix added to function signatures) |
| Compiled binary (`clang -O2 -lm -lz`) | **165 KB** | **34 KB (-80%)** |
| Global text symbols (`nm`'s `T`) | 443 | 2 (`main` + Mach-O header) |

`hello.c`'s `main` only calls `printf` + `as_str_concat`, and never touches Stage / graphics / files / byte
streams. Those 443 global symbols were all dead code — "builtin-class method bodies + thunks".

---

## 2. Root Cause: Method Bodies Emitted as Global Symbols, `-O2` Cannot Eliminate Them

`nm` showed that not a single unused builtin class was eliminated:

```
00000001000088a0 T _ByteArray_compress      ← global text (T)
000000010000fadc T _ByteArray_new
000000010001d578 d _MovieClip_methods       ← static data (d), referenced by the method body
```

The root cause is a single point:

- **Builtin-class method bodies (`Date_ctor` / `ByteArray_compress` / thunk `Xxx_m__dyn`) are emitted as
  global symbols (`T`, non-`static`).** clang must assume "other translation units may reference them", so
  `-O2`'s dead-code elimination (DCE) **does not apply** to global symbols.
- The vtable / props / methods reflection tables are **already `static`**, but they are referenced by the
  "global method bodies" (the function pointers `&Date_getTime` in the vtable, and the `Date_getTime` calls in
  the reflection-table thunks); as long as the method bodies survive as global symbols, this static data
  becomes "reachable" and is kept alongside them.

**Conclusion**: the bulk of the binary size is not the runtime (the `RUNTIME_PREAMBLE` functions have long been
`static`, and `-O2` already eliminated the unreferenced ones), but the **builtin-class method bodies as "global
symbols"**. The fix is to mark them `static` and let `-O2` prune them itself — **this is a visibility marker at
the "semantic translation" layer, not a hand-written optimization pass**.

---

## 3. The Implementation: `staticizeTopLevelFunctions()`

`run()` in `src/emit.ts`, after emitting `main`, calls `staticizeTopLevelFunctions()` once, which uniformly
adds `static` to "non-exported file-scope functions":

- **Always kept global**: `main` (the program entry) and the `[WasmExport]` exported symbols (`symbol` + alias
  wrapper, required for the wasm export table / cross-translation-unit visibility).
- **Made `static`**: builtin-class and user-class method bodies, ctor/new, thunks, free functions, prototype
  declarations.
- Line-by-line recognition of `return-type function-name(` located at column zero (no indentation) as a
  function definition/declaration; skips `static`/`typedef`/`extern`/`struct`/preprocessor/comment lines.

`-O2` then builds a complete call graph from `main`:

```
main ── doesn't touch Date ──> Date_new unreachable ──> Date_vt unreachable
                                            ├── Date_methods / Date_props unreachable
                                            └── Date_getTime + thunk unreachable → all eliminated
```

**Horizontal references handled automatically** (this is the most painful point of "prune-by-class" schemes):
`Transform_ctor → Matrix_new/ColorTransform_new`, `Shape_ctor → Graphics_new`,
`TextField_ctor → TextFormat_new`, `Stage_dispatchFrame → MovieClip/Timer` — these **non-inheritance**
horizontal calls all go through static calls within the same translation unit, and `-O2`'s call-graph analysis
naturally covers them — **no dependency edge table or per-class pruning to maintain**.

---

## 4. Why Not "On-Demand Emission of Builtin Classes" (the Original P0)

The earlier plan (`p0-tree-shaking.md`, since deleted) intended to do AST reference scanning +
fixpoint closure in Pass 1, pruning the skeleton and method bodies by class. It was abandoned after
measurement, for these reasons:

1. **The gain is actually worse than static-ization**: P0 expected the binary to drop to 40–60 KB;
   static-ization goes straight to 34 KB.
2. **Far heavier implementation**: it needs an AST scanner (`noteTypeRef`/`scanExpr`/`scanStmt`) + fixpoint +
   3350 lines of method bodies grouped by class + a hand-maintained horizontal-dependency edge table for the
   builtin classes.
3. **The risk of missing a prune is real**: `super/implements` closure cannot cover horizontal calls inside a
   method body (the ones listed in §3); a missed prune means an undefined symbol and a link failure.

Static-ization hands the "which classes to emit" decision **entirely to `-O2`'s call-graph analysis**, with
correctness and completeness guaranteed by the compiler's mature algorithm and zero semantic burden on the
front end.

---

## 5. Constraints and Boundaries

- **Cross-translation-unit / glue layer**: the Skia/SDL2/Metal glue (`.cc`/`.mm`) for `air-native` generates
  the `.c` via **function-pointer callbacks** (`on_frame`/`on_mouse`/`on_frame_delay`), and does not require
  the `.c`'s internal symbols to be global; the generated `.c` calls the glue via `extern "C"` declarations.
  Static-ization does not affect multi-target linking (`air-native` full-link verification has passed).
- **Dynamic instantiation `new (expr as Class)`**: `as_class` only carries the two pointers `vtable` +
  `factory`, referencing "classes explicitly used as `Class` values"; those classes are naturally kept alive by
  the `main` reachability chain, with no reliance on a full registration table.
- **`[WasmExport]`**: exported symbols (including the alias wrapper) always stay global; all non-exported
  functions are static.

---

## 6. Acceptance

- `hello.as` binary 165 KB → 34 KB, with byte-identical output.
- `node test.ts` full regression 80 passed / 0 failed (including `air-native` full Skia/SDL2 linking,
  `wasm-native` export, and the GUI window example).
