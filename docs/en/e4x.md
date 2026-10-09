# E4X / XML Investigation and Project Initiation

> This document answers one question: **the Starling framework makes heavy use of `flash.xml`'s XML/E4X — should
> the AOT compiler do it, to what degree, and how should it land**. The core conclusion up front: **the E4X that
> Starling actually uses is a very narrow subset — almost no bare XML literals (`<root/>` written directly in
> the source), all of it runtime `new XML(bytes)` / `XML(str)` construction + `@attr` property access +
> `.child` child-node paths + E4X filter predicates `.(@attr == value)`**. So there is no need to implement
> E4X's hardest parts ("XML literals + `{}` embedded expressions + namespace literals"); all that is needed is:
> ① modeling the two builtin types `XML`/`XMLList`; ② a hand-written minimal XML parser (zero third-party
> dependencies at compile time/runtime, reusing the minimal-parsing approach already proven in `air-app.ts`);
> ③ syntax support for the `@` operator and the postfix navigation `.child`/`.(pred)`; ④ `describeType`'s XML
> output.
>
> Every conclusion in this document is based on an item-by-item measured tabulation of E4X usage in
> `examples/air-starling-demo` (142 files / 34658 lines), not a paraphrase of documentation.

---

## 1. Why This Requirement Exists: Starling's Asset Loading Pipeline Depends on XML

Starling's asset system (`AssetManager`/`XmlFactory`/`TextureAtlas`/`BitmapFont`) treats texture atlases (atlas
XML) and bitmap fonts (BMFont `.fnt`, essentially XML) as core input formats. `AssetManager.enqueue("a.xml")` →
`XmlFactory.create` → `new XML(bytes)` parse → dispatch `TextureAtlas`/`BitmapFont` by root-node name → read
attributes with `@attr`. **Without XML support, Starling cannot even load texture atlases and bitmap fonts**, a
hard prerequisite of the rendering pipeline.

`describeType` also depends on XML: `AssetManager.enqueue(Class)` uses the XML returned by `describeType(asset)`,
iterating `constant.(@type=="Class")` / `variable.(@type=="Class")` / `metadata.(@name=="Embed")` to extract
`[Embed]` metadata. The two are of the same origin — both blocked on the XML/E4X builtins (TODO stage
eighty-six already deferred `describeType` to here).

---

## 2. Measurement: the Exact E4X Range Starling Uses

File-by-file grep (excluding ASDoc tags such as `@param`/`@return`/`@see` in comments and `Vector.<T>` generic
angle brackets), the real E4X usage is as follows:

### 2.1 Construction (all runtime construction, no bare XML literals)

| Form | Location | Note |
|---|---|---|
| `new XML(bytes)` | `utils/AssetManager.as:953`, `assets/XmlFactory.as:39` | constructed from a `ByteArray` |
| `XML(str)` | `text/MiniBitmapFont.as:187` | constructed from a `String` (functional call without `new`) |

**Key fact**: grepping the whole repository for `=<`, `return <`, `:<` finds **no bare XML literal**
(`var x:XML = <root/>`). This means **the lexer need not implement E4X's XML-literal mode (the hardest `<`
state-machine switch)**.

### 2.2 Property Access `@attr`

| File | Count | Typical form |
|---|---|---|
| `textures/TextureAtlas.as` | 13 | `subTexture.@name`, `subTexture.@x`, `@frameWidth` … |
| `text/BitmapFont.as` | 17 | `fontXml.info.@face`, `charElement.@id`, `kerningElement.@amount` … |
| `utils/AssetManager.as` | 11 | `xml.@imagePath`, `typeXml.@name`, `childNode.@name` … |
| `assets/AssetManager.as` | 14 | `node.@name`, `arg.@value`, `typeXml.@name` … |
| `assets/XmlFactory.as` | 4 | `xml.@imagePath`, `xml.pages.page.@file`, `xml.info.@face` |

Note: the **result of `@attr` is a String by default** (E4X semantics: an attribute value is auto-`toString()`ed),
and can continue the chain with `.toString()` — `xml.info.@smooth.toString() == "0"`. This is AS3 semantics, not
a C behavioral coincidence.

### 2.3 Child-Node Paths `.child` (dot navigation)

| Form | Location | Note |
|---|---|---|
| `xml.pages.page.@file` | `XmlFactory.as:69`, `AssetManager.as:770` | multi-level `.child` then `@attr` |
| `fontXml.chars.char` | `BitmapFont.as:170` | iteration target |
| `fontXml.kernings.kerning` | `BitmapFont.as:188` | iteration target |
| `fontXml.distanceField.length()` | `BitmapFont.as:158` | child-node existence check |
| `atlasXml.SubTexture` | `TextureAtlas.as:119` | `for each (var subTexture:XML in atlasXml.SubTexture)` |

### 2.4 E4X Filter Predicate `.(@attr == value)` (the hardest part)

| Form | Location | Note |
|---|---|---|
| `typeXml.constant.(@type == "Class")` | `utils/AssetManager.as:574`, `assets/AssetManager.as:271` | filter constant nodes with `@type=="Class"` |
| `typeXml.variable.(@type == "Class")` | same | filter variable nodes |
| `variableDeclarationNode.metadata.(@name == "Embed")` | `assets/AssetManager.as:313/331` | filter metadata nodes |
| `embedMetadata.arg.(@key == "source"/"mimeType")` | `assets/AssetManager.as:314/332` | filter arg nodes |

`.(...)` is E4X's **filter predicate**: it screens the `XMLList` returned by `.child` with a predicate,
returning the subset satisfying the condition. This is the core semantics distinguishing E4X from an ordinary
DOM, and the highest-cost part to land.

### 2.5 Methods / Builtins

| Call | Note |
|---|---|
| `xml.localName()` | root-node name (dispatching `"TextureAtlas"`/`"font"`) |
| `xml.@attr.toString()` | attribute value to String |
| `xml.distanceField.length()` | child-node existence (returns `int`) |
| `asset is XML` / `asset as XML` | type test/conversion (`assets/AssetManager.as:1013`) |
| `System.disposeXML(xml)` | explicit release (6 places, a `System` builtin) |
| `describeType(x):XML` | reflection description (2 places) |

---

## 3. AS3 E4X Semantics vs C (Correctness Red Lines)

E4X is a product of the ES4 spec, fully inherited by AS3. The differences that must be handled explicitly when
translating:

| E4X semantics | C pitfall | Correct approach |
|---|---|---|
| `@attr` returns an `XMLList`, but in a scalar context implicitly `toString()`s | no C counterpart | Model as "XML node + attribute table"; at compile time `@attr` expands directly to `as_xml_attr(xml, "attr")` returning an `as_value` (String); `.toString()` is a no-op returning its own string |
| `.child` returns an `XMLList` (the set of child nodes) | no XMLList in C | Model as `as_xml_list` (array of child-node pointers); `.child.grandchild` takes grandchild of each child node and flattens |
| `.(pred)` filter predicate | no predicates in C | Runtime predicate evaluation: `.(@name=="Embed")` → for each child, check whether the `@name` attribute equals `"Embed"`, keep if so |
| `for each (x in xml.child)` | iterates an `XMLList`, not an Array | `XMLList` is made iterable (reuse `as_vector` or a dedicated linked list), `for each` goes through `as_xml_list_get(list, i)` |
| `xml.localName()` | no C counterpart | each XML node stores a `name` field |
| `xml.distanceField.length()` | no C counterpart | returns the child-node count as `int` |
| `XML`/`XMLList` are `Object` subclasses, supporting `is`/`as`/`==` | needs box tags | Add box tags (e.g. `as_v_xml`/`as_v_xml_list`), **synchronously updating the five places `as_v_typeof`/`as_v_truthy`/`as_v_eq`/`as_v_str_val`/`gc_mark_value`** (AGENTS.md §2.4 red line) |
| `new XML(bytes)` constructs from a ByteArray | needs to parse XML text | hand-written minimal XML parser (DOM tree: element/attribute/text), reusing the minimal-parsing approach already proven in `air-app.ts`, zero third-party dependencies |
| `describeType` returns XML | needs to generate a description tree | reflection table + generated XML tree (`<type>`/`<extendsClass>`/`<constant>`/`<variable>`/`<accessor>`/`<method>`…) |

**The XML-parser tradeoff** (corresponding to AGENTS.md §2.9's "link mature libraries" iron rule):

- Candidate 1: link a mature XML library (libxml2/tinyxml2/expat). Pros: robust, full XML 1.0 support. Cons:
  introduces a C++/system dependency, conflicts with the "generate readable C + zero third-party dependencies"
  default form, and E4X's `.child`/`@attr`/`.(pred)` semantics still need a self-built adaptation layer.
- Candidate 2 (**recommended**): hand-write a minimal DOM parser (pure C, embedded in `RUNTIME_PREAMBLE`, zero
  dependencies). Starling's XML input is **atlas/font metadata, structurally regular, with no DTD/entities/
  namespaces**, and a minimal parser (three node kinds element/attribute/text + recursive descent) suffices.
  `air-app.ts` already has a precedent hand-written minimal XML extractor (extracting only fields like `<id>`/
  `<filename>`), an approach already proven.

Conclusion: **hand-write the minimal DOM parser first**, covering the XML subset Starling actually feeds it; if
a full XML 1.0 need arises later, evaluate linking a library. This is consistent with the regex engine's "self-built
ES3 backtracking VM" decision logic — E4X semantics (`.child`/`@attr`/`.(pred)`) must be self-built anyway, and
the parser is only a small piece of it, so pulling in an external dependency for that small piece is not worth it.

---

## 4. Landing Status (stages ninety through ninety-three, all completed)

| Layer | Status |
|---|---|
| `lexer.ts` | ✅ `@` is recognized as a postfix operator (E4X attribute access); ✅ **XML literal** mode (landed in stage one-hundred-six for `<a b="1">…</a>`: recursive name-stack balancing, comments/CDATA/PI, `{expr}` interpolation **loudly rejected**; stage one-hundred-eight fixed the scan defect "text between sibling elements was not skipped ⇒ an indented multi-line literal reported `unterminated regular expression`") |
| `parser.ts` | ✅ `expr.@attr`, `.child` E4X navigation, `.(pred)` filter predicate, the **descendant axis** `x..name`/`x..*` (stage one-hundred-six), the **two computed-name axes** `x.ns::[expr]` (child axis) and `x.@[expr]` (attribute axis) (stage one-hundred-eight, the `ns` qualifier folded away as "namespace compile-time transparent"), `XML`/`XMLList` type annotations |
| `symbols.ts` | ✅ `XML`/`XMLList` modeled (`kind:'xml'/'xmllist'`); `System.disposeXML` modeled |
| `emit.ts` | ✅ `describeType` really implemented as `as_describe_type` (`<type name="pkg::class"/>` XML tree, falling back to `<type name="Object"/>` for non-Classes); ✅ computed names dispatch by receiver (xml/xmllist → `as_xml_*`, Proxy/dynamic-object attribute axis → `as_dyn_get`, all other receivers **loudly** `CodegenError`) |
| `runtime.ts` | ✅ Embedded `as_xml_parse` minimal DOM parser + the whole `as_xml_attr`/`as_xml_children`/`as_xml_filter`/`as_xml_descendants`/`as_xml_list_*`/`as_describe_type` helper set; **the child axis compares by "local name"** (`as_xml_local()`, stage one-hundred-eight) |

---

## 5. Landing Layering (completed, see TODO.md stages ninety through ninety-three)

Split into four stages by "dependency order + verifiable per stage", **all landed and regression-passing**
(`examples/stage90~93.as`, 94 passed / 0 failed); the formal registration is in TODO.md's main roadmap entries
"stages ninety through ninety-three" (the version number was not bumped, `package.json` stays 0.3.108):

| Stage | Content | Version | Acceptance |
|---|---|---|---|
| ninety | `XML`/`XMLList` type modeling + minimal XML parser | to be bumped | `stage90.as` |
| ninety-one | `@attr` attribute access + `.child` child-node navigation | to be bumped | `stage91.as` |
| ninety-two | E4X filter predicate `.(@attr == value)` | to be bumped | `stage92.as` |
| ninety-three | `describeType`'s XML output | to be bumped | `stage93.as` |

> **Correction (stage one-hundred-eight)**: the old conclusion in the row above is **outdated** — XML literals and
> the `..` descendant axis landed in **stage one-hundred-six** (see the §4 table), and `ns::[expr]`/`@[expr]`
> computed names plus namespace-prefix handling landed in **stage one-hundred-eight**. Still unimplemented:
> ① **namespace modeling** (the qualifier is transparent ⇒ the same local name with a different uri cannot be
> distinguished, a `Namespace` value is only a placeholder); ② `..*` **does not count text nodes** (AIR counts
> them; `5.desc-any` gives 2 for us / 4 for AIR); ③ **general filter predicates** `.(<expr>)` (only the
> `.(@attr ==/!= value)` form is supported); ④ `+`/`+=` XML concatenation.
> All registered in `TODO.md`'s leftover table.

---

## 4b. Computed Names and Namespaces (stage one-hundred-eight, `adl 51.4.1` value log `temp/nsbracket/`)

`x.ns::[expr]` (child axis, yielding an `XMLList`) and `x.@[expr]` (attribute axis, yielding a `String`) are the
**idiom of DAE/COLLADA parsing** (away3d `DAEParser.as:982` / `:1046`). Measured contract:

| Form | `adl` | Note |
|---|---|---|
| `x.ns::[name]` | matches children with a **matching namespace** | a child with no prefix + a foreign ns gives **0**; `ns::["nope"]` gives 0 |
| `x[name]` (unqualified) | **0** (for prefixed nodes) | **not** the same thing as `ns::[name]` |
| `@[expr]` | **equivalent to** `@literal` | `@[at]`/`@["kind"]` have values, `@["nope"]` is `""`, `@id == @["id"]` is true |

**This subset's approximation**: the `ns` qualifier and node prefixes are both "compile-time transparent" — the
child axis compares the **local name** (taking the part after the last `:` via `as_xml_local()`), so
`x.ns::["item"]` gives **2 (= AIR)** on `<n:item>`, but `x.item` (unqualified) **also gives 2** (AIR gives 0).
`toString()` still writes back `<n:item>` verbatim (storage keeps the prefix), and `localName()` reports `item`
(consistent with AIR). When writing a probe, one can only obtain the namespace object via `xml.namespace()`
(`new Namespace(prefix, uri)` is not implemented).

---

## 6. Difficulties and Risks

| Difficulty | Note | Mitigation |
|---|---|---|
| E4X filter predicate `.(pred)` | Runtime predicate evaluation must express "for each child node, look up the attribute and compare" at the C layer | The predicate forms are limited (measured: only `@attr == "str"`), so at compile time the predicate is lowered to an "attribute name + expected value" pair, compared linearly at runtime |
| Confusing `XML`/`XMLList` with `Object`'s dynamic index `obj[key]` | `asset[node.@name]` (`assets/AssetManager.as:268`) is an `Object` dynamic index, unrelated to XML | Already handled by `as_dyn_get`; the XML path is separate |
| GC scanning of the newly added box tags | A new tag needs a `gc_mark_value` branch, otherwise the DOM tree is dangled and collected | Update item by item per AGENTS.md §2.4's red-line checklist |
| Robustness of the minimal parser | A hand-written parser must report an error on invalid XML rather than silently swallowing it | Invalid input throws an `Error` (consistent with §2.5's ban on silent error-swallowing) |