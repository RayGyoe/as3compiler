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

### 2.6 String Value and `XML(ByteArray)` (stage one-hundred-forty-three, `adl 51.4.1` value logs `temp/acme-mac/{xmlstr,xmlba}/`)

The real app acme-app loads its language resource via `XML(new language_en())`
(`[Embed(..., mimeType="application/octet-stream")]` ⇒ the generated resource class is a **ByteArray subclass**),
and measuring it pinned down two rules:

**1. `XML(value)` accepts a ByteArray** (its bytes are the UTF-8 markup text). When the call site's static type
is `Class`/`*` the **dynamic** branch runs, so `as_xml_from_value` must recognize ByteArray — including every
ByteArray subclass (`as_is` walks the `super` chain, so every `[Embed]` class matches).

| Input | `adl` | This subset |
|---|---|---|
| `XML(ba)` (UTF-8 markup) | the parsed tree (multi-byte characters intact) | ✅ same (`examples/xml-embed.as`) |
| `XML(new <octet-stream Embed class>())` | same | ✅ same |
| `XML(xmlNode)` | pass-through | ✅ same |

**2. `toString()` is the E4X "string value", not the markup**:

| Shape | `toString()` | `toXMLString()` |
|---|---|---|
| text node `new XML("plaintext")` | `plaintext` | `plaintext` (✅ since stage two-hundred-eight, see below) |
| `<a b='1'>txt</a>` (**no** element children) | `txt` | `<a b="1">txt</a>` |
| `<a b='1'/>` (no children) | `""` | `<a b="1"/>` |
| `<a> </a>` (whitespace-only text) | `""` | `<a/>` |
| `<a b='1'><c d='2'/></a>` (**has** element children) | the markup (indented 2 spaces) | same as `toString()` |
| `<a>x<b/>y</a>` | the markup (**interleaved** in document order) | same as `toString()` |
| `XMLList`: 0 / **1** / ≥2 items | `""` / **that item's string value** (`"a"`) / the items' **markup** joined by a newline | `""` / **that item's markup** (`<i>a</i>`) / same as the left |

**Landed in stage one-hundred-ninety-three** (measured against the same `adl 51.4.1` batch, `temp/toxml/`: all 24
XML + XMLList cells match verbatim): `toXMLString()` now lowers to the markup serialiser `as_xml_to_string`
(`as_xml_list_to_xml_string` for an `XMLList`), and that markup **re-indents** the way AIR does — **no** element
children ⇒ a single inline line (`<a b="1">txt</a>`); **has** element children ⇒ one item per line, 2 spaces per
level, the closing tag back at its own level, with whitespace-only text nodes **dropped**; attributes are always
**double-quoted**; comments and the `<?xml …?>` declaration are dropped. The end-to-end assertions live in
`examples/e4x-toxmlstring.as`, the structural pins in `test/unit/emit.ts` under `unit: e4x/ToXMLString`.

**Stage two-hundred-eight: the three parser residuals are aligned** (measured verbatim against `adl 51.4.1` with a
differential probe in `temp/e4xres/diff/` — 63 records **byte-identical**; end-to-end assertions in
`examples/e4x-text-mixed.as`, structural pins in `unit: e4x/TextNodes`). All three lived in the **parser**; the
serialiser was only dragged along by the shape of the DOM:

**① Text-node construction.** When the argument of `new XML(...)` contains **no `<`**, the argument itself IS a text
node (not an error):

| Input | `nodeKind()` | `localName()`/`name()` | `toString()`/`toXMLString()` | `text()` | `length()` | `children()` |
|---|---|---|---|---|---|---|
| `"plaintext"` | `"text"` | `null` / `null` | `plaintext` | `""` | 1 | 0 |
| `"  hi there  "` | `"text"` | — | `hi there` (edges trimmed) | `""` | 1 | 0 |
| `""` / `"   "` | `"text"` | — | `""` | `""` | 1 | 0 |

`text()` is **not** the node's value: it selects the text **children**, and a text node has none. `name`/`localName`
are `null`, so a named axis (`x.foo`) never matches a text node. Markup or stray text **outside** the root element is
still a document-level `#1088` (see the error table below).

**② Mixed content in document order.** The DOM no longer folds into a single `text` slot; every text run becomes a
**child** inserted at its position, interleaved with elements:

| Shape | old (wrong) | now = `adl` |
|---|---|---|
| `<a>a<b/>b</a>` | `<a>\n  ab\n  <b/>\n</a>` | `<a>\n  a\n  <b/>\n  b\n</a>` |
| `<a>x<b/>y<c/>z</a>` | folded into `xyz` | `<a>\n  x\n  <b/>\n  y\n  <c/>\n  z\n</a>` |
| `<a> a <b/> b </a>` | — | each run is trimmed **on its own** |
| `<a>x<!--c-->y</a>` | — | a comment **splits** the run ⇒ two text children, two lines |
| `<a> <b/> </a>` | — | whitespace-only runs are **dropped** ⇒ `children()` = 1 |
| `<a>&#32;</a>` | — | empty only **after decoding** ⇒ keeps an empty text node, prints `<a></a>` |

The axes follow: `children()` / `child("*")` / `.*` / the **descendant axis `..*`** all **include** text nodes
(`.*` = 4 and `..*` = 5 for `<a>t1<b>bt</b>t2<c/></a>`), while `elements()` is the element-only axis (2). The
inlining rule also changed shape: **exactly one** text/CDATA child stays inline, everything else pretty-prints — so
`<a>pre<![CDATA[mid]]>post</a>` is three lines while `<a>txt</a>` stays one.

**③ Entities: decode on input, escape per context on output.** The old parser did not decode, so the output could
only echo (`&#65;` never became `A`) and the serialiser could not escape (it would double-escape). Now the two
directions are separated:

| Input | `toString()` | `toXMLString()` |
|---|---|---|
| `<a>&#65;&amp;&lt;&gt;&quot;&apos;&#x42;</a>` | `A&<>"'B` | `<a>A&amp;&lt;&gt;"'B</a>` |
| `<a>&foo;</a>` (unknown named) | `&foo;` (verbatim) | `<a>&amp;foo;</a>` (only `&` escaped) |
| `<a>&amp;lt;</a>` | `&lt;` (decoded **once**) | `<a>&amp;lt;</a>` |
| `<a>&#x1F600;</a>` / `<a>&#0;</a>` | verbatim | escaped, still verbatim |
| `<a><![CDATA[<b/> & raw]]></a>` | `<b/> & raw` | `<a><![CDATA[<b/> & raw]]></a>` (re-emitted **as CDATA**, not decoded, not trimmed) |

Two AIR quirks are copied deliberately: `&nbsp;` decodes to **U+FFA0** (not U+00A0), and numeric references decode
only up to **U+FFFF** (anything above the BMP, and `&#0;`, stay verbatim). The escape sets differ per context: text
escapes `&`/`<`/`>` (quotes and whitespace raw); attribute values escape `&`/`<`/`"` and write TAB/LF/CR as
`&#x9;`/`&#xA;`/`&#xD;` (`>` and `'` stay raw, and attribute values are **not** trimmed).

Errors are `TypeError`s whose `errorID` can be asserted directly (the old parser raised `#1090` for everything):

| Trigger | `adl` |
|---|---|
| unterminated element / mismatched close tag | `#1085: The element type "a" must be terminated by the matching end-tag "</a>".` (names the **open** element) |
| markup or stray text outside the root | `#1088: The markup in the document following the root element must be well-formed.` |
| malformed tag / EOF inside a start tag / unquoted attribute | `#1090: XML parser failure: element is malformed.` |

**Still left on this row** (independent of the three above): element names are not escaped; a CDATA section
containing `]]>` is not split; `attributes()` still returns only the first attribute's value.

### 2.7 An XML/XMLList in a Dynamic Slot Must Be Its String Value Too (stage one-hundred-forty-four, measured in `temp/xmlstr3` + `temp/apv/adl`)

The rules above cover a **statically known** `var s:String = xml` (the emitter calls `as_xml_string_value` directly).
But as soon as the value travels through a **dynamic slot** — `Object`, `*`, an array element, a `Dictionary` value, a
dynamic property, an `Object` parameter — it lands in the **object vtable's string conversion slot** (`box_to_str`)
instead, which answered `[object XML]`.

What is emitted today: acme-app stores its localized labels in an XML document and resolves them through
**dynamic lookups**, so **every label** on its login page (and the window title) rendered `[object XML]`.

| Shape | `adl` | Before the fix | Now |
|---|---|---|---|
| `String(o)` with `o:Object` holding an XML | the text | `[object XML]` | ✅ the text |
| `"" + o` / an XML passed to a parameter | the text | `[object XML]` | ✅ the text |
| `[x][0]`, and the array's own `toString()` | the text | `[object XML]` | ✅ the text |
| `{k:x}.k` (a dynamic property) | the text | `[object XML]` | ✅ the text |
| an `XMLList` through a dynamic slot (0 / 1 items) | `""` / that item's string value | `[object XMLList]` | ✅ same |
| `xml as String` | `null` (an XML is not a String) | `null` | ✅ unchanged |

**Implementation**: `as_xml_vt`/`as_xml_list_vt` now use `as_xml_box_to_str`/`as_xml_list_box_to_str` as their
`box_to_str` slot instead of `as_object_box_to_str` (both delegate to `as_xml_string_value`/
`as_xml_list_to_string`). Behaviour: `examples/xml-dynamic-str.as`; the last three checks of
`unit: e4x/StringValue` pin the wiring.

### 2.8 The XML Shape of `describeType` (stage one-hundred-eighty-six, measured in `temp/dtor` + `temp/t1`)

`describeType`'s output is the **only** input of the app's model mapper (`BaseModel.fromJSON`): it walks
`describeType(this)..variable` / `..accessor` and assigns JSON fields onto the model by `@name`/`@type`. The
implementation used to emit a **childless** `<type name="pkg::class"/>`, so `..variable` was always empty, every
field kept its AS3 default, a nested model stayed `null`, and the next read threw an uncaught `#1009` (the root
cause of the real app freezing on a meeting click). Stage one-hundred-eighty-six aligns it with `adl 51.4.1`:

| Semantics | Measured form |
|---|---|
| `@name` / `@type` | use **`::`** (`pkg::PackThing`, `flash.display::Sprite`, `__AS3__.vec::Vector.<int>`), not dots |
| instance view | `base="<direct superclass>"`, `isStatic="false"`, traits inline; **an `Object` instance has no `base` and no `<extendsClass>`** |
| class view | `base="Class"`, `isStatic="true"`, `<extendsClass type="Class"/>` + `<extendsClass type="Object"/>` + `<accessor name="prototype" access="readonly" type="*" declaredBy="Class"/>`, traits under `<factory type="Name">` |
| inheritance | `<extendsClass>`/`<implementsInterface>` list the **full chain** (nearest first, `Object` included) |
| visibility | **public members only** |
| `variable` / `constant` | **no** `declaredBy`; an absent attribute reads as the **empty string** (as in AIR) |
| `accessor` / `method` | **have** `declaredBy`; an accessor carries `access="readonly\|writeonly\|readwrite"` |
| `method` | carries `returnType` and one `<parameter index/type/optional>` per parameter; a **rest parameter is not listed** |
| `<constructor>` | only when the constructor **has parameters** (the signature lives in the `as_dt_ctors[]` side table -- a class with a parameterized ctor and no methods of its own has no place for it in the method tables) |
| interface names | via the `as_dt_iface_names[]` side table (an interface vtable has only a 5-field prefix, no `fqn` slot) |
| `Object`'s own traits | **never listed** (neither for a subclass nor for a plain object) ⇒ `describeType({})` is a bare `<type name="Object" isDynamic="true" isFinal="false" isStatic="false"/>` |
| primitives / containers | `int`/`Number`/`String`/`Boolean` → `isDynamic=false`, `isFinal=true` (plus a readonly `length` for `String`); `Array` → dyn=true/fin=false + a readwrite `length`(uint); `Vector.<int>` → dyn=true/**fin=true**; `flash.utils::Dictionary` → dyn=true; `Date` has no package |
| `describeType(null)` | the **empty string**; `describeType(undefined)` throws `#1010` |
| member order | AIR uses an **unreproducible hash order**; we use declaration order -- a **deliberate** difference (`adl`'s own order varies between runs) |

**Approach**: rather than a new per-class describeType blob, the **existing reflection tables** were widened
(`as_prop` gained `is_accessor`/`is_const`, `as_method` gained `sig`, the vtable header gained
`is_dynamic`/`is_final`) and the XML is assembled from them at runtime. That keeps the size low, and when
`describeType` is never called `-O2` strips the whole block (it is `static`).

**Two safety rules to remember**:

1. **"Is this a class instance?" may only be answered by COMPARING the candidate's first word against
   `as_class_registry[i].cls->vtable`** -- the GC body of an `Array`/`Dictionary`/`Vector`/`XML` starts with a
   **data/name pointer**, and dereferencing it as a vtable crashes. Comparing never dereferences, and pairing it
   with an `as_dyn_kind(v.ptr) != 0` gate removes both the misclassification and the crash.
2. **`as_prop_read`'s tag 10 (a field whose declared type is `Array`) must box as `as_v_arr` (tag 6)**, not as an
   object -- otherwise the array's **data pointer** is exposed as a vtable to every reflective consumer
   (`String(x)`, `is Array`, a dynamic access).

Behaviour: `examples/describe-type.as`; structural pins: `unit: reflect/DescribeType`, `unit: reflect/PropBoxing`.

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
| `emit.ts` | ✅ `describeType` really implemented (stage one-hundred-eighty-six aligns it fully with `adl 51.4.1`, see §2.8): the reflection tables are emitted per class (`as_prop` carries `is_accessor`/`is_const`, `as_method` carries `sig`, the vtable carries `is_dynamic`/`is_final`) and the XML tree is assembled at runtime by `as_dt_shape`/`as_dt_traits` (`<type>`/`<extendsClass>`/`<implementsInterface>`/`<variable>`/`<constant>`/`<accessor>`/`<method>`/`<parameter>`/`<factory>`); ✅ computed names dispatch by receiver (xml/xmllist → `as_xml_*`, Proxy/dynamic-object attribute axis → `as_dyn_get`, all other receivers **loudly** `CodegenError`) |
| `runtime.ts` | ✅ Embedded `as_xml_parse` minimal DOM parser + the whole `as_xml_attr`/`as_xml_children`/`as_xml_filter`/`as_xml_descendants`/`as_xml_list_*` helper set; **the child axis compares by "local name"** (`as_xml_local()`, stage one-hundred-eight); ✅ the `describeType` assembler (`as_dt_class_of`/`as_dt_shape`/`as_dt_traits`, stage one-hundred-eighty-six, see §2.8), where a candidate object is **only ever compared against a registry vtable, never dereferenced** |

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
| one-hundred-eighty-six | `describeType`'s XML shape **fully aligned with `adl`** (it used to emit a childless `<type name="pkg::class"/>` ⇒ the model mapper got nothing ⇒ an uncaught `#1009`) | v0.4.166 → v0.4.167 | `describe-type.as` |

> **Correction (stage one-hundred-eight)**: the old conclusion in the row above is **outdated** — XML literals and
> the `..` descendant axis landed in **stage one-hundred-six** (see the §4 table), and `ns::[expr]`/`@[expr]`
> computed names plus namespace-prefix handling landed in **stage one-hundred-eight**. Still unimplemented:
> ① **namespace modeling** (the qualifier is transparent ⇒ the same local name with a different uri cannot be
> distinguished, a `Namespace` value is only a placeholder); ② `..*` **does not count text nodes** (AIR counts
> them; `5.desc-any` gives 2 for us / 4 for AIR); ③ **general filter predicates** `.(<expr>)` (only the
> `.(@attr ==/!= value)` form is supported); ④ `+`/`+=` XML concatenation.
> All registered in `TODO.md`'s leftover table. ⑤ **`toXMLString()` is unimplemented** (loud `CodegenError`);
> ⑥ the markup output is **not re-indented the way AIR does** and **does not drop whitespace-only text nodes**
> (measured in stage one-hundred-forty-three, see §2.6).

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