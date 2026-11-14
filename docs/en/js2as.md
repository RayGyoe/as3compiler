# js2as: a restricted JS→AS3 translator (`scripts/js2as.ts`)

> One sentence: it turns a **pure-algorithm** JS file into AS3 through a **whitelisted
> subset**, so the compiler's own semantic regression can be run against it; anything
> outside the subset is **refused by name with a `line:col`**, never guessed at.

The tool exists for **upstream sync**: `asaot3d/apps/nyc-m36` is aligned visually against
the web build (`mrdoob/slop-newyork`), and that build's city generation, traffic,
pedestrians and camera control keep changing. Re-typing the AS3 port by hand each time is
slow and error-prone, so those files are treated as inputs and the translation step is
frozen here.

## 1. Why not "general JS transpilation"

The house rule is "emit readable C, and a semantically wrong translation is worse than a
missing feature" (AGENTS.md §0/§2.4). Piping the whole web project through meets four
layers, and **only the first is a language problem**:

| Layer | What breaks | Verdict |
|---|---|---|
| Language semantics | prototype chains, `this` rebinding, closure capture, dynamic properties, Promises, module resolution | statically translatable, but every access degrades to `Dictionary` + reflection — exactly the silent downgrade §2.4 forbids |
| Render pipeline | compute passes / storage buffers / MRT / indirect draws in the TSL graph | the backend seam (`s3d_native_set_targets`) binds a single colour attachment; a **backend capability gap**, not a language one |
| Geometry semantics | `InstancedMesh`, no 16-bit index ceiling | ditto |
| Assets | `city.json`, textures, models are already data | translating them is meaningless |

So the tool sits at the **second granularity**: it eats only files that do not touch
WebGPU/TSL/compute. Rendering stays hand-written (translating a TSL node graph to GLSL is
a separate channel, see [`native-shader.md`](native-shader.md)).

## 2. The subset

### Accepted

- `var` / `let` / `const` (`let` is rewritten to `var`; see the block-scope note in §3)
- `function` declarations and expressions, recursion, default parameters
- **arrow functions** (rewritten to AS3 anonymous functions, see §3; a body that mentions
  `this`/`arguments`/`super` is refused)
- **object/array destructuring** (in declarations and in parameter lists; rewritten to
  property/index reads, see §3)
- `if` / `for` / `while` / `do-while` / `switch` / `break` / `continue` / `return`
- object literals `{a: 1}`, array literals `[1, 2]`, `new Array(n)`
- `+ - * / %`, comparisons, `&& || !`, `?:`, `typeof`, `===/!==`, bitwise operators
- template literals (expanded to string concatenation, see §3)
- `export` statements (a single-file output has no module boundary, see §3); `import` is refused
- `Math.*`, `Number(...)`, `parseInt/parseFloat`, `JSON`

### Refused (every one with a `line:col` and what to write instead)

| Construct | Message (excerpt) |
|---|---|
| `class` | `classes are not in the subset; write an AS3 class with typed fields` |
| spread / rest `...` | `spread/rest is not in the subset` |
| `for...of` | ``for-of is not in the subset; use an index loop (AS3 `for each` iterates values, not entries)`` |
| nested pattern `{a: {b}}` | nested destructuring: "destructure one level at a time" |
| rest in a pattern `{...r}` | `rest in a destructuring declaration is not in the subset` |
| computed key `{[k]: v}` | `computed or nested key` |
| `this` inside an arrow | an AS3 anonymous function would rebind it, so it is refused rather than rebound |
| `**` | `the exponent operator is not in the subset; use Math.pow` |
| optional chaining `?.` | `optional chaining is not in the subset; guard with an explicit null test` |
| `async`/`await`/`yield` | refused by name |
| `arguments` | ``the implicit `arguments` object has no AS3 equivalent in the subset`` |
| `import` | `imports are not in the subset (the file is not self-contained); translate a file that stands alone` |
| `export *` / `export default` / `export ... from` | each refused by name (all of them need the other module) |
| multi-line template literal | `multi-line template literals are not in the subset (line numbers must survive translation)` |

`of` is only refused inside a `for (` header; as an ordinary identifier (`const of = 1`)
it is allowed — a refusal targets **the construct**, not a name that a valid file may use.

## 3. Rewrites

| JS | AS3 | Why |
|---|---|---|
| `let x = 1` | `var x:* = 1` | AS3 has no block scope; a `let` in the subset does not cross a block |
| `console.log(...)` and friends | `trace(...)` | both print their arguments space-separated to the host log |
| `process.hrtime.bigint()` | `(new Date().getTime() * 1000000)` | NOT monotonic. Only "subtract two readings" is equivalent; a negative duration would expose the difference, which is why it is stated here instead of hidden |
| `` `a=${x}b` `` | `("a=" + (x) + "b")` | expanded by a string pass **before lexing** (the compiler has no template token, and a JS-only feature does not belong in the compiler); multi-line templates are refused so line numbers survive. A template nested in an interpolation is expanded recursively |
| `(a, b) => expr` | `(function (a:*, b:*):* { return expr; })` | AS3 **has** anonymous functions, so an arrow is expressible; the one thing that is not is `this` (an arrow's `this` is lexical, an AS3 anonymous function's is the call receiver), which is refused instead of rebound |
| `(a) => { ... }` | `(function (a:*):* { ... })` | the block is kept verbatim; only types are added |
| `const { x, z: sz } = o` | `const x:* = o.x, sz:* = o.z` | a property read is the same operation in AS3 |
| `const [p, , q] = arr` | `const p:* = arr[0], q:* = arr[2]` | holes skip their index |
| `const { a } = pick()` | `const __d0:* = pick(); const a:* = __d0.a` | a non-identifier source is materialised so it is evaluated **exactly once** (as in JS) |
| `const { a = 5 } = o` | `const a:* = (typeof o.a === "undefined") ? 5 : o.a` | a default fires on `undefined` only (not on `null`), which is why it tests `typeof`; the compiler has no `undefined` identifier |
| `function f({ a, b }, c)` | `function f(__p0:*, c:*) { const a:* = __p0.a, b:* = __p0.b; ... }` | positional identity is preserved; the unpacking happens at the top of the body |
| `const { a } = o, b = 1` | `const a:* = o.a, b:* = 1` | the rest of the declarator list is carried over |
| `export function f` / `export const K` | `function f` / `const K` | a single-file output has no module boundary |
| `export { f };` | the statement is blanked (**its line is kept**) | line numbers must survive |
| `import ...` | - (refused) | a file with imports is not self-contained, and guessing which side a name lives on is a guess |

Type annotations: **every binding is `:*`** (AS3 dynamic). That is the faithful mapping of
a JS value (ES3 ToPrimitive, `+`, `==`, boxing), and the compiler already implements those
semantics for `*`. No inference — see §5.

## 4. Self-check: the output must parse

`jsToAs()` runs the **compiler's own parser** over its result before returning. A failure
reports `translated output does not parse, which is a js2as bug`. That separates "your JS
uses a construct I do not support" (a located refusal) from "I emitted broken AS3" (a tool
bug); without it the latter would surface downstream as a baffling compile error.

## 5. Why there is no type inference (with measurements)

Every JS→typed-language translator is tempted to infer. This one **deliberately does not**,
and the reason is measurement, not caution:

- `nbody` (a physics loop dominated by object field access), all-`*` vs "annotate every
  provably-numeric binding as `Number`": **390 ms vs 394 ms** (2000 steps, within noise).
- A pure arithmetic loop (20M × `s += i * 0.5`): **7 ms either way**, and 7 ms on `node`.

`-O2` inlines the `as_value` boxing/unboxing away (the tag tests fold locally), so scalar
boxing is not the bottleneck at all. The 400x comes entirely from **dynamic member access**:

```js
b[i].x      // string-keyed lookup + boxed index, on every single access
```

Local type inference cannot fix that. Fixing it needs **object shapes** (every property name
and type) so `{x:0,y:0,...}` becomes a typed class or `Vector.<T>` — whole-program analysis
with real semantic risk, in direct conflict with "missing beats wrong". The honest
conclusion: **hand-write a typed port for hot loops**; the translator owns correctness and
cold paths.

## 6. Measurements: five benchmarks end to end

Shape: `node scripts/js2as.ts <x>.js -o temp/x.as && node src/index.ts temp/x.as --run`,
compared with `node <x>.js`. **All five checksums match bit for bit.**

| Benchmark | node | translated | ratio | hand-written AS3 port |
|---|---:|---:|---:|---:|
| `fib` (fib(40)) | 536 ms | 1092 ms | 2.0x | 212 ms |
| `nbody` (2000 steps) | 1 ms | 390 ms | ~390x | 199 ms for 5M steps (translated equivalent: ~16 min) |
| `mandelbrot` | 87 ms | 753 ms | 8.7x | — |
| `strings` | 91 ms | 214 ms | 2.4x | — |
| `array` | 18 ms | 21294 ms | 1183x | — |

The ratio tracks the density of dynamic member/element access: `fib` is scalar arithmetic
(2x), `strings` runs string builtins (2.4x), `array` does `a[i]` reads and writes on a `*`
array every step (1183x). That column is not a defect list but a **selection guide**: it
says which code shapes may be translated and which must be hand-ported.

`benchmarks/oop/oop.js` is written around `class` and is refused by name — typed classes are
exactly where a hand port belongs.

### 6.1 The first real upstream file: `js/vehicle-physics.js` -> native, bit-identical to node

The target is `temp/slop-newyork/js/` (the web build nyc-m36 is aligned against: 24 files,
34k lines). Before destructuring and arrows landed, **not one file got through**; the nearest is
the 162-line `vehicle-physics.js` (0 `import`, 0 `class`, 0 arrows, 1 object destructuring and a
trailing `export { ... }`).

Method: `js2as` emits 163 lines of AS3, an A/B harness is appended to that same file, and the
result is compared against `node` line by line. The harness prints **integers only** (every
field is scaled by 1000 or 1e6 and rounded), so the comparison cannot be fooled by
Number-to-String formatting differences between JS and the AS3 runtime.

**All 14 lines agree bit for bit** (8 `vehicleContact`/`resolveVehicleContact` fixtures and 6
`sweptVehicleContact` ones), including the no-contact and NaN paths. This is exactly how the
conditional defect in §8 item 3 surfaced: the first run printed `contact.x` as 0 for every
fixture, while `closing` -- computed *inside* `resolveVehicleContact` from that same field --
was perfectly correct. The difference was only "read it out, then use it".

It also draws the boundary: `pedestrian-routes.js` (219 lines) stops at object spread
(`{...extra}`), `building-collision.js` at `for...of`, and the big files are far off
(`traffic.js`: 103 destructuring sites, 31 arrows, 9 imports; `cars.js`: 95 arrows). **The use
is cold-path algorithm checking, not replacing render logic**: `src/city/*.as` is a typed
implementation, and an all-`*` translation is orders of magnitude slower on a per-frame hot
path (§5/§6).

## 7. Usage

```bash
node scripts/js2as.ts path/to/input.js -o path/to/output.as
node scripts/js2as.ts path/to/input.js            # to stdout
```

The output starts with `// Transpiled from <input> by scripts/js2as.ts -- regenerate, do not hand-edit.`
so nobody mistakes it for hand-written source.

## 8. Three compiler gaps fixed along the way

Translating hit three places where legal AS3 did not compile, or compiled to the wrong
value. All were fixed at the root (§0) rather than worked around in the tool -- the first two
came from `nbody`, the third from the first real upstream file:

1. **`++` / `--` on a `*` slot did not compile.** The emitter treated the target as a C
   lvalue and wrote `(g_x++)`, which clang rejects (`cannot increment value of type
   'as_value'`). AS3 allows incrementing an untyped slot (ES3 §11.3.1/§11.4.1: read and
   write both go through `ToNumber`). It now expands to `x = as_v_num(Number(x) ± 1)`, and
   the value of a **postfix** use is `ToNumber(old)` — so `"5"++` yields `5` (a `Number`)
   and the slot becomes `6`; a non-numeric string yields `NaN`. Statement position and a
   `for` update clause (where the value is discarded) leave no unused temp behind.
2. **`const x:* = 5;` did not compile.** It emitted `static const as_value g_x = as_v_num(5);`,
   and a C `static` initialiser must be a compile-time constant. Any slot whose C type needs
   a constructor call even for a literal (`*` is an `as_value`) is now runtime-initialised:
   the declaration carries the default and the initialiser runs once in `main()`, in source
   order — the same path `static const d = new Dictionary()` already used. `int`/`Number`/
   `String` literals remain true C static constants (generated C unchanged).

3. **A conditional coerced one arm into the other arm's static type** (found on
   `js/vehicle-physics.js`). `unifyType(any, int)` chose `int` and `convert` then unboxed the
   `any` side, so `v == null ? 0 : v` with `v = 0.974` **silently answered 0**; likewise
   `true ? 0 : "x"` stringified the 0 into `"0"`. This is the same defect `&&`/`||` had already
   been fixed for (AGENTS.md §2.4): a conditional returns the **chosen operand's value** and
   does not convert it. It now shares the same gate as `&&`/`||` -- only same-kind or
   both-numeric pairs may share a C type, otherwise both arms are boxed -- while a `null` arm
   keeps `unifyType`'s exact rules (the G16 `? null : Bitmap` case is unaffected).

All have regressions: `examples/dynamic-inc.as` (end-to-end assertions), `test/unit/js2as.ts`,
and `test/unit/logical.ts`'s `unit: logical/TernaryOperand` (source-level pins on the emitted C).

## 9. Still not done

- **Object shape inference** (§5): the only way to speed up hot paths, and the riskiest.
- Closure-captured variables are still passed as `*`; no escape analysis.
- `for...of` is not rewritten into an index loop: over an object it can mean keys or values
  depending on the object, and guessing is a semantic error, so it is left to the author.
- Multi-file / modules: one file at a time.
- The type-promotion code was **deleted** (not postponed): it measured no gain (§5), so
  keeping it would be pure maintenance cost.