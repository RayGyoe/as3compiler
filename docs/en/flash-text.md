# Text Display Alignment (`flash.text` / `TextField`) Investigation and Integration Plan

> **Trigger**: the AOT ↔ `adl` difference report for the real app acme-app
> (workspace root `acme-app-aot-vs-adl-diff.md`, 2026-10-14) collapses 12 visible
> differences into 4 root causes — of which **R2 (SWC `DefineEditText`/`DefineText` bake neither
> text nor `TextFormat`)** and **the text items of R3** (`as_str_alloc(1)` without a terminator,
> `displayAsPassword` masking per byte, font-alias/metric residuals) all land on the single
> `flash.text` surface. This is a **charter document**: it takes stock of the current state and the
> gaps, gives the display matrix and example contract, then splits "aligning the `TextField`
> mountain" into work packages that can each be accepted per stage.
>
> **One-line conclusion**: `TextField`'s **runtime layout** (SkParagraph / rich text / line metrics /
> input-editing-selection-scroll) is already fairly complete; what is owed is mainly two families —
> **A. SWC static text and `TextFormat` are never baked** (the biggest mountain; one change covers six
> appearance diffs), and **B. runtime-contract gaps** (memory safety, masking, aliases, metrics,
> `TextFormat` subset). The only oracle is **AIR 51.4.1's `adl`**, aligned value by value; if `adl`
> runs it right and we cannot ⇒ it is a legacy defect (AGENTS §1.5).

---

## 0. Scope and non-goals

**In scope**

- `flash.text.TextField`'s **display** surface: text content, `TextFormat` fields, rich text
  (`htmlText` + `StyleSheet`), line/char metrics, `autoSize`, `displayAsPassword`, `border`/`background`,
  `textColor`.
- **Static text characters** baked from SWC (`DefineText` tag 11/33, `DefineEditText` tag 37): bake the
  initial text + `TextFormat`, and make `SimpleButton` draw nothing for an undefined state.
- The runtime contracts the display surface needs (string-terminator contract, font-family aliases;
  `Capabilities.language` is filed under the "language" surface but is cross-referenced where it
  affects this surface's copy, see §2).

**Non-goals (separate domains)**

- A full rewrite to **UTF-16 code-unit indexing** (`String.length`/`charCodeAt`/the whole `TextFormat`
  family are byte-based ⇒ would rebuild the entire runtime string layer). This plan only guarantees the
  **text display** is self-consistent under the byte contract and matches AIR's **visible result**;
  the systematic length/index difference stays a recorded item (see §2 D-T8).
- **SWF-embedded fonts** (`DefineFont2/3` + glyph outlines) fidelity: AIR draws SWC text with the SWF's
  embedded font, we use system fonts ⇒ the outlines can never match pixel for pixel. This plan only
  aligns the **parseable** attributes (text content, size, colour, bold/italic, alignment); outline
  differences are reported in `notes` (§3.3 makes this explicit).
- morph / `DefineMorphShape` (another domain).

---

## 1. Current state (what is already done)

The `TextField` surface is not new — more than a dozen sub-stages have accumulated since stage 38. The
table below is the **pre-work inventory**, so we do not redo capabilities that already exist.

| Capability | Status | Landing |
|---|---|---|
| Single/multi-line layout (SkParagraph + HarfBuzz, UAX#14 line breaking) | ✅ | stages 38/44, `vendor/skia_glue.cc` `sk_textlayout_*` |
| `TextFormat` subset (`font/size/color/bold/italic/underline/leading/align/kerning/letterSpacing`) | ✅ (subset) | stages 38/72/89·17 |
| Horizontal alignment (with layout width → Skia per-line; without → `as_tf_align_dx` block shift) | ✅ | stages 89·17/135 |
| Rich text: `htmlText` subset (`span,p,b,i,u,font,a,li,br,img,textformat`) + `setTextFormat` ranges | ✅ | stages 72/148 |
| `StyleSheet` real class + block-level HTML model (break-after) | ✅ | stage 148 |
| `autoSize` (none/left/center/right) | ✅ | stage 72 |
| Line metrics `getLineMetrics` / `flash.text.TextLineMetrics` | ✅ (per line) | stage 103 |
| Internal geometry conversion (`as_tf_index_at` click points, caret/selection rects, per-line `getLineMetrics`) | ✅ (internal) | stages 94·15/135 |
| **Public geometry/text-query API family** (`getCharBoundaries`/`getCharIndexAtPoint`/`getLineIndexOfChar`/`getLineText`/`getFirstCharInParagraph`/`getImageReference`) | ❌ (loud `undefined method`) | this plan, package B |
| Editable text: caret, selection, edit keys, `restrict`, `displayAsPassword` masked rendering | ✅ | stages 94·7/94·8/135 |
| Scrolling `scrollV`/`maxScrollV`/`scrollH`/`mouseWheelEnabled` | ✅ | stages 38/135 |
| `border`/`borderColor`/`background`/`backgroundColor`/`textColor` | ✅ | stage 94·8 |
| Font-family alias translation (`_sans`→Helvetica, `_serif`→Times New Roman, `_typewriter`→Monaco, NULL→Times) | ✅ | stage 94·20, `vendor/skia_glue.cc` `sk_family_alias` |
| Line-box model (AIR half-pixel rounding, drop line gap, fold leading) | ✅ (≤0.5px residual) | stages 94·20/135 |
| SWC: `DefineEditText`/`DefineText` **placeholder children** (existence/count correct) | ✅ (**empty shell**) | stage 95·8 |
| SWC: `DefineEditText`/`DefineText` **initial text + `TextFormat`** | ❌ | this plan, package A |
| SWC: `SimpleButton` undefined state (`upState == NULL`) draws nothing | ❌ | this plan, package A |

---

## 2. Gap list (item by item: symptom / root cause / code location / evidence)

IDs `D-T*` cross-reference the report's `D*`. Where `adl` runs it right and we cannot ⇒ **legacy
defect** (AGENTS §1.5).

### A. SWC static text and `TextFormat` (the biggest mountain)

| # | Symptom (adl vs us) | Root cause | Code location | Evidence |
|---|---|---|---|---|
| **D-T1** | The footer's two lines `Acme Healthcare Communications.` / `cdn.acme.example` are **missing entirely**; the agreement line's 《隐私政策》/《服务协议》 copy is missing | `DefineEditText`/`DefineText` bake **only an empty `TextField`**; the initial text is never decoded | `src/swc.ts` `SwcText` (§`CHARACTER_TAG_KINDS`); `src/emit.ts` `as_swc_new`'s text branch (`case ${ch.id}: { TextField* t = TextField_new(); t->_fieldWidth=…; }`) | report D2; `temp/cmp/shots/P2_*` |
| **D-T2** | SWC built-in fields' Latin text renders **serif** (Times-ish); adl is sans | The placeholder `TextField`'s `defaultTextFormat` is `TextField_ctor`'s `TextFormat_new(NULL,12,…)` ⇒ `font == NULL` ⇒ `sk_family_alias` lands on Times | `src/emit.ts:16177` (`o->defaultTextFormat = TextFormat_new(NULL, 12.0, …)`) | report D2 |
| **D-T3** | SWC built-in fields are **left-aligned** (tab label ~52px left), adl centres within half the pane; `登录` is **black**, adl teal | Same: `align == NULL` ⇒ `as_tf_align_index` returns 0; `color == 0x000000` | `src/emit.ts:16215` `as_tf_align_index` | report D2, `cmp_tabs.png` |
| **D-T4** | When `SimpleButton.upState == NULL` we draw the **down/hit state** (two grey blocks); adl draws nothing | The baked button has `up=NULL; over=NULL;`, and rendering falls back to down/hit | `src/emit.ts` `as_swc_build_87` region; the `SimpleButton` render branch | report D3 |

> **Leverage point**: D-T1/2/3 are **one change** (decode `DefineEditText`'s `HasText/initialText`,
> `FontHeight/HasFont/TextColor/Align/Layout/Leading` and `DefineText`'s `TEXTRECORD` on the SWC side,
> baking `t->text = …` + `t->defaultTextFormat = TextFormat_new(font, size, color, bold, italic, leading, align)`)
> covering six appearance diffs at once. **This is the largest and highest-yield item in this plan.**

### B. Runtime-contract gaps

| # | Symptom | Root cause | Code location | Evidence |
|---|---|---|---|---|
| **D-T5** | An empty `TextField` renders the residue of the "previous text layout" (`MS: 17` / `_sans`, different each run) | `TextField_ctor` uses `o->text = as_str_alloc(1)` — 1 byte, `gc_alloc` **deliberately does not zero** `GCT_STRING`, **no terminator written**, so `strlen` reads whatever that GC block last held → violates the `as_str_alloc` contract (caller writes the NUL) | `src/emit.ts:16140`; contract at `src/runtime.ts:968`. Same class: `src/emit.ts:12789/12791` (`Socket__str`) | report D4 (decisive experiment: set a red/bold/mono format with empty text ⇒ residue becomes red mono) |
| **D-T6** | Password field masks per **byte** (`请输入密码`, 5 CJK chars → 15 stars), adl 5; star colour black vs adl grey 162 | `as_tf_layout_text` replaces per **byte** (one star per byte) while AIR counts **UTF-16 code units** | `src/emit.ts` `as_tf_layout_text` (`m[i] = (c=='\r'||c=='\n') ? c : '*'`) | report D9, `cmp_pwd.png` |
| **D-T7** | The `_sans`/`_serif` generic aliases' **line height** differs (ours 12/13, adl 15.5/15); `textWidth` excludes trailing spaces (AIR includes); glyph-advance ≤0.5px residual | AIR uses a **non-linear built-in device font metrics table** for the three generic aliases; no parseable face reproduces it | `vendor/skia_glue.cc` `sk_air_line_metrics`/`sk_round_half` | legacy rows "`_sans`/`_serif` line height", "`textWidth` without trailing spaces", "glyph-advance residual" |
| **D-T8** | `String` is a **UTF-8 byte index** (not UTF-16 code units): `"中".length` is 3 for us, 1 for adl; the same source as `displayAsPassword` star count and edit indices | A direct consequence of the runtime string representation | `src/runtime.ts` string layer | legacy row "UTF-8 byte index" (**not** a goal of this plan, see §0) |
| **D-T9** | `TextFormat` fields are a subset: missing `leftMargin`/`rightMargin`/`indent`/`blockIndent`/`bullet`/`display`/`tabStops`/`url`/`target`; ctor takes 6 params (AIR 11) | Not modelled | `src/symbols.ts` `TextFormat` classMap | legacy row "`TextFormat` fields are a subset" (**loud error**, not silent) |
| **D-T10** | Multi-line run **line height is ~1.5× too large**; a rule's `leading` is not folded into the run; `getLineText` is unimplemented | Incomplete evidence collection for per-run line boxes; `as_ss_str(rule,"leading")` is unread | `src/emit.ts` htmlText/run path | legacy row "htmlText multi-line run height", stage 148 |
| **D-T11** | `TextField.textWidth` excludes trailing spaces (AIR includes); glyph-advance ≤0.5px residual | Which glyphs are taken / advance rounding | `vendor/skia_glue.cc` metric path; `as_tf_*width*` | two legacy rows |
| **D-T12** | The public geometry/text-query API family is **entirely unimplemented** (`getCharBoundaries`/`getCharIndexAtPoint`/`getLineIndexOfChar`/`getLineText`/`getFirstCharInParagraph`/`getImageReference`) — calls fail loudly with `undefined method` | Only the **internal** conversion exists (`as_tf_index_at`, `as_tf_line_*`); they were never exposed as AIR's public API; the method table has only `getLineMetrics`/`appendText`/`setSelection`/`setTextFormat`/`getTextFormat` | `src/symbols.ts` `TextField` classMap `methods`; `src/emit.ts` `as_tf_*` geometry helpers | TODO legacy row "`getLineText` is unimplemented"; a tree-wide `grep` in this repo has 0 hits |

### D. Font face switching between two font files that share family + PS name (stage 167, ✅ fixed)

| # | Symptom | Root cause | Code location | Evidence |
|---|---|---|---|---|
| **D-T15** | Same source: `adl` draws `创建同传`, we draw `初开名伤`; **ASCII/Latin and other CJK families (PingFang SC, 华文细黑) are fine**, only family `微软雅黑` is hit | CoreText re-copies the CTFont in `SkCTFontCreateExactCopy` with an **attributes-only descriptor**, so it re-resolves by **family**; on this machine `微软雅黑.ttf` (Regular) and `微软雅黑粗体.ttf` (Bold) share family **and** PS name and CoreText picked the other file — the two files' glyph orders diverge at index 110 ⇒ every CJK gid draws **the next character** (Latin gids agree, hence unharmed) | **third-party library patch** (not our generated C): `vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch` → `src/utils/mac/SkCTFontCreateExactCopy.cpp`; rationale and full evidence in [`skia.md`](skia.md) §6.9 | same-source dual-end probe `temp/tfswc/` (`BitmapData.draw()` + `getPixels()` raw ARGB): after the fix `微软雅黑`/`Microsoft YaHei`/`华文细黑` ink-mask **IoU 100.00%** (vs `adl`), PingFang SC 97.24%; `ctprobe3..6.mm` located the switch, `skgl.mm` proved the rasterizer was the side shifting; regression nail `unit: build/SkiaLocalPatch` (guards the patch provenance) |

> The defect is **not** a shaping/cmap/font-coverage gap (all three shapers agree on `创=1259`) and does **not**
> affect the wasm/Windows backends (the patch sits inside `SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS`).
> Reproduction needs that pair of same-family same-PS-name files installed, which CI does not have ⇒ **no
> examples assertion**.

### E. `autoSize` sizing contract + the fallback face for an uninstalled family (stage 168, ✅ fixed)

| # | Symptom | Root cause | Code location | Evidence |
|---|---|---|---|---|
| **D-T16** | The AI subtitle list item's `title` (a skin field, family `MiSans Regular`, `wordWrap=true`) is **broken into three lines and runs over the `ctime`** of the same child under the app's assignment order (`autoSize=LEFT` → `text=…`), while adl keeps one line | The `autoSize` width hug used the **already-wrapped** layout's longest line `+4` ⇒ the narrower field makes the usable width equal the text width ⇒ the next layout breaks once more and the longest line gets shorter ⇒ **every repaint shrinks it again** (measured 290 → 64.66 → 50.66 → 36.66 → 32). adl's contract: with `wordWrap=true` the width **stays put** and only `height = textHeight + 4` follows; only `wordWrap=false` sets `width = textWidth + 4` (both directions) | `src/emit.ts` `as_tf_apply_autosize` (`if (!tf->wordWrap) tf->_fieldWidth = tw + 4.0;`) plus the `as_do_extents` hook that refreshes `autoSize` on a geometry read | same-source dual-end probe `temp/tfswc` cases 6/7/8/10 (the AOT report is **byte-identical** to adl's after the fix); `examples/autosize-metrics.as`; `unit: display/AutoSizeMetrics` |
| **D-T17** | The same list item's **line height**: ours 20 (size 14) vs adl 14, so `ctime.y` sits 6px lower; same for `宋体`, `MiSans` and any uninstalled family (16px box: ours 22, adl 16) | We hand an uninstalled family to Skia ⇒ `matchFamilyStyle` returns NULL ⇒ SkParagraph takes the line box from the **CJK face that supplied the glyphs** (PingFang/Songti SC, 1.4 em); AIR uses the **platform default** (Helvetica) box | `vendor/skia_glue.cc` `sk_family_alias` (substitutes `matchFamilyStyle(nullptr)`'s family name when the family is not installed, cached) + the `sk_match_typeface` fallback | `temp/tfswc` cases 9/10 (`MiSans Regular`/`宋体` 16px box = 16, matching adl; 22 before the fix); `famprobe.mm` (both names return NULL from `matchFamilyStyle` here); `examples/autosize-metrics.as` case 4 |

> **Note**: §2C's **N3** (`autoSize` resizes the field box: adl `auto-left` → `52×19.5`, us still `100×100`) is
> the same D-T16 defect observed on the no-draw path and is fixed together with it (`width`/`height` reads now
> refresh `autoSize`).
> This does **not** depend on app fonts: `adl` **also does not register** the bundled `MiSans-Regular.ttf`, so
> "register app fonts for native" would move us away from the oracle — deliberately not done in this stage.

### F. Metrics and glyph contract for a scaled field (stage 169, ✅ fixed)

| # | Symptom | Root cause | Code location | Evidence |
|---|---|---|---|---|
| **D-T18** | The AI subtitle list item's card is **2.5pt taller** than adl: for the same child `ctime` our `textHeight` reads `14.00` while adl reads `11.45` (the app feeds it straight into `bg.height = ctime.textHeight + ctime.y + title.y`). `ctime`'s SWC placement carries **scaleX = 1.2246** (scaleY = 1) | We returned the **local layout's nominal extents** from `textWidth`/`textHeight` (i.e. ignored the scale), whereas AIR reports **nominal × scaleY / scaleX** — **both extents divided by scaleX** (not each by its own axis) — with the scale taken over the **accumulated** chain (the object plus every ancestor: a parent at scaleX=2 halves a child field's extents too) | `src/emit.ts`: new `as_disp_chain_scale` (walks `parent`, multiplying the linear parts in `T·R·S·transform.matrix` order) + `as_tf_scale_ratio` (`sy/sx`), applied by `TextField_get_textWidth`/`TextField_get_textHeight` (including the pure-C fallback branch) | `adl 51.4.1` same-source dual-end probe `temp/tfswc` cases ⑯⑯b (size 12, nominal 166.00/12.00): `(2,1)→83.00/6.00`, `(1,2)→332.00/24.00`, `(2,2)→166.00/12.00`, `(0.5,1)→332.00/24.00`, `(1,0.5)→83.00/6.00`, parent `scaleX=2→83.00/6.00`; after the fix ours reads `166.10/12.00`, `83.05/6.00`, `332.19/24.00`… (width keeps only `MiSans`' inherent 0.06% delta, height is **byte-identical**); `examples/tf-scale-metrics.as` + `unit: display/TfScaleMetrics` |
| **D-T19** | The same child's text is **22% wider** than adl (`开始时间: 2023-02-10 17:50:00`: ours 204pt, adl 170pt), i.e. the placement's scaleX **stretched the glyphs horizontally** | A non-uniform CTM was applied to the text (Skia stretches both glyphs and advances by `sx`). AIR scales the glyphs **uniformly by the accumulated `scaleY` only** and never widens them by `scaleX` — the box still widens (`width` = local width × scaleX) | `src/emit.ts`, the TextField glyph pass: post-concatenate `scale(sy/sx, 1)` onto the CTM **after** the `clipRect` (deliberately after: Skia maps a clip through the CTM in force at clip time and the visible box must follow scaleX); the ratio is read from the **destination CTM** (`ASC_bake_ctm_*`, same idiom as the 1px border) so bakes/`draw` degrade to 1 automatically | `temp/tfswc` case ⑯ window screenshots plus cases ⑯c/⑰b raw ARGB: ink width at `(2,1)`, `(0.5,1)` and parent `scaleX=2` is 165.0pt (= unscaled), at `(1,2)` it is 329.5pt (= 2×); `draw(field)`/`draw(container)` **both ignore the source's own transform** (adl: a scaleY=2 field dumps a **byte-identical** raster to an unscaled one), so the scale has to ride on an **intermediate Sprite** to be measured |

> These are the third batch of residuals from the same window (the AI subtitle list item `subtitleskin`): stage 167 fixed
> the header glyphs, stage 168 the item's wrapping/line box, and this stage the `ctime` scale contract.
> **Deliberately not done**: exposing the placement scale through `DisplayObject.scaleX` (adl reports
> `ctime.scaleX = 1.2246`, we still report 1.0) — that would touch the established nine-slice contract and is a
> separate registered divergence (see [`swc.md`](swc.md) §9.2 F5 and note ① of the AGENTS.md SWC measurement contract).
> Side effect reported honestly: a field that is **both `autoSize`d and scaled at runtime** still computes
> `width` from the local nominal extents `+ 4` and then multiplies by scaleX (adl: `(nominal/sx) + 4` then × sx);
> e.g. `scaleX=1.2246` + `autoSize=LEFT` gives us `208.30` against adl's `170.90` (for skin children, whose
> placement never reaches `scaleX`, the gap is only 0.9pt) ⇒ recorded with the same family of residuals, not
> addressed here.

### G. Text-child `x`/`y` (RECT origin) under a placement, and `TextFormat` "unset" fields (stage 170)

| # | Symptom | Root cause | Code location | Evidence |
|---|---|---|---|---|
| **D-T20** | The AI subtitle item's `ctime` sits **12pt to the left** of adl (real window: ink starts at `30` vs `54` device px). With the card height and text width already aligned, this was the window's **last** residual | The SWC bake treated a text child's `RECT` origin as a **translation** (`x = matrix.tx + xmin`), while AIR treats the origin as a **point in the character's own space**: it goes through the placement's **linear part**, and AIR then stores the result on its **twip grid** (1/20 px) — `x = round20(tx + a·xmin + c·ymin)`, `y = round20(ty + b·xmin + d·ymin)`. The old form matches AIR exactly for **unit-scaled** children, which is why `temp/childfx`'s 99 children (all scale 1) never caught it | `src/emit.ts`: new `Emitter.swcTextChildXY(m, ox, oy)`; both the frame-1 `emitSwcPlacement` and the timeline modify path now funnel through it; the interface comment in `src/swc.ts` was updated to match | `adl 51.4.1` dual-end probe `temp/tfswc` case ⑰: `subtitleskin.ctime` old `0.30` / new `11.9913→12.0000` / adl **`12.0000`**; three more discriminating cases `filesskin.tab1` `0.0500`, `filesskin.tab2` `90.1000`, `logintabskin.tab1` `0.0000` (old form: `-0.40`/`89.65`/`-0.10`); all six rows identical after the fix; pinned by `unit: swc/TextChildOrigin` (7 pins, goes red under mutation); real window `ctime` ink `53..393` vs adl `54..394` |
| **D-T21** | Registered the same round, **not fixed**: ① `defaultTextFormat = new TextFormat()` (all fields null) wipes font/size/color/bold/`leading` to their defaults on our side, whereas adl **changes nothing** (it is a no-op) ⇒ we lose the SWF-declared `leading=2` (`textHeight` nominal `14.02 → 12.00`), and `dtf.size = null` degenerates to `size=0`; ② our `TextFormat` member table is missing `indent`/`blockIndent`/`bullet`/`tabStops`/`target`/`url` and the constructor takes **6 params vs AIR's 13** ⇒ AIR-valid code **fails to compile** here | ① fields are typed `number`/`bool` so they **cannot express "unset"**, and the setter overwrites wholesale; ② the member table/constructor were never completed against AIR's class docs | unchanged (direction: represent "unset" explicitly + merge per field in the setter + add the 6 members and 13-param constructor) | `temp/tfswc` cases TF0–TF8 (adl side): TF7 reads back the **original values** after an all-null `TextFormat` (ours: `font=null size=12 color=0 bold=false lead=0`), TF2 `th` ours `9.80` vs adl `11.45`, TF3/TF4 explicit `leading=0/2` agree on both ends (`9.80/11.45`, proving the gap is only in the "unset" state), TF5/TF8 show adl **keeps** `size`/`leading` when they are null; `indent` fails on our side with `Codegen error: undefined field 'indent' on class 'TextFormat'`. Diff list **D41 / R28**; registered in the backlog table |

> **A lesson worth keeping**: D-T20 hid behind a "99 children matched item by item" acceptance run — that sample was
> **entirely unit-scaled**, and the two forms only diverge when the placement carries a scale. The **coverage
> dimension** of a sample (here: scale) matters as much as its size. D-T20 is **fixed** (stage 170 / v0.4.141);
> D-T21 is **measured and registered only** this round: it changes `TextFormat`'s default-value path (touching every
> text example and skin field's initial layout), so it needs its own stage plus a full regression.

### C. First measurement findings (dual-end `examples/textfield` report, 2026-10-14)

A line-by-line diff of the two reports (`temp/textfield-oracle/{adl,aot}.txt`, **79 cases**) surfaced 8
**new differences** not covered by the §2 A/B tables (IDs `N*`, backfilled into the items to fix):

| # | Symptom (adl → us) | Belongs to | Note |
|---|---|---|---|
| **N1** | `defaultTextFormat.align` default: adl `"left"` → us `null` | new, package B | affects **every** case line (that is why the differ count is inflated) |
| **N2** | With `font=null`, `defaultTextFormat.font`: adl reports `"Times Roman"` → us `null` | new, package B | read-back only (rendering is already Times) |
| **N3** | ~~`autoSize` **resizes the field box**: adl `auto-left` → `52×19.5` → us still `100×100`~~ **✅ fixed (stage 168, see §2E D-T16)** | new, package B | `textWidth/Height` are right; the **field's own** `width/height` differ — a `width`/`height` read now refreshes `autoSize` |
| **N4** | The `displayAsPassword` setter **does not invalidate the existing layout**: text first, then password ⇒ adl `tw` is still the **plaintext** width (`WWWWWW` → 67.50 = `plain-W`); password first, then text ⇒ star width (28.00) | new, **narrows D-T6** | we **always** lay out the star string ⇒ the set order is observable in adl, invisible to us |
| **N5** | Our star glyph width **matches** adl (6 stars `28.02` vs `28.00`) | narrows D-T6 | the only gap is the **count contract** (CJK per byte ⇒ 3 stars), not the glyph width |
| **N6** | `_sans`/`_serif` line height appears in **every** case (`th` 12 vs 15.5 / 13 vs 15); trailing spaces (`trail-space1` 27.35 vs 30.50); glyph advance (`W` 67.96 vs 67.50, `i` 16.00 vs 15.50) | D-T7 / D-T11 | confirms existing rows |
| **N7** | `BitmapData.draw()` does **not alpha-composite**: the destination's existing content is **overwritten pixel by pixel** by the source. Same `new BitmapData(w,h,false,0xFFFFFFFF)` + `draw()`, and adl's backdrop is **still white** afterwards (100% of pixels have `alpha>=8`) while ours keeps only the 4.2% the source actually inked (the rest was written as `0x00000000`) | new, **`BitmapData` surface** (found by the §5.2 UI channel) | measured (per-pixel tally of both ends' `textfield-grid.raw`); `src/emit.ts` `BitmapData_draw` sampler tail `dp[…] = (sa<<24)\u007c\u007c…` writes unconditionally |
| **N8** | Does `Graphics.lineStyle(0, …)` draw a hairline at all? We read `hasStroke = thickness > 0` ⇒ **no stroke**; the AIR side is **unmeasured** | **open question** (`Graphics` surface) | the grid drew its field boxes with `lineStyle(0)` first and **nothing appeared on our side**; to avoid mixing two contracts in one place the harness switched to 1 |

> **D-T6 root cause narrowed**: it is not "the star glyph width is wrong" but two things — ① AIR uses one
> star per **UTF-16 code unit** (we use one per byte); ② AIR's `displayAsPassword` setter **does not
> re-layout** (we recompute the star string on every layout). ② is why the app's usual order
> `tf.text=…; tf.displayAsPassword=true;` never shows stars.

**D-T13 `htmlText` does not decode HTML character references** ✅ (fixed in stage 149)

- **Symptom**: the second footer line in acme-app is ` &nbsp;&nbsp;…&nbsp;cdn.acme.example`; before the
  fix the `&nbsp;` were drawn as visible characters (8 groups = 48 characters wide). AIR decodes both the
  named entities and the numeric references into real characters.
- **Root cause**: the plain-text accumulation in `as_tf_html_set` was a bare byte copy
  (`out[opos++] = html[i]`) with no entity branch at all.
- **Fix**: new `as_tf_html_entity` (named `&amp; &lt; &gt; &quot; &apos; &nbsp;` plus decimal/hex numeric
  references; rejects 0 and the surrogate range), dispatched on `&`.
- **Verified**: three `examples/textfield` cases against `adl` — `html-entity-nbsp` 20.00/20.02,
  `-named` 55.50/55.51, `-numeric` 32.00/32.00.

**D-T14 the whole `DefineEditText` field was not decoded** ✅ (fixed in stage 149, i.e. §4's T2a)

- **Symptom**: **every line of text** a skin shipped was missing (acme-app's agreement paragraph / footer /
  button captions); the child count and index order were right, the fields were just empty.
- **Root cause**: `swc.ts` read only the text character's `RECT` — `SwcText` had no text or format — and
  `as_swc_new`'s `'text'` branch built an empty `TextField`.
- **Fix / pitfalls / verification**: see §9 "T2a". Two format pitfalls: the flags must be read as a
  **MSB-first 16-bit word** (not a little-endian `UI16`), and `TextColor` is **RGBA**.

### Cross-references (not on this surface, but exposed by the same report)

- `Capabilities.language` **fixed in stage one-hundred-eighty-seven** (it used to read the process `LANG` on
  Windows, so it always answered `"en"` and the whole site switched to English; it now reads the **system UI
  language** per AIR and normalizes it into the closed set — see [`win32.md`](win32.md) §3.8). **Filed under the
  "language" surface**; not re-chartered here. This plan only references it where it affects **copy**.
- `System.totalMemory` scale (report D6), `BitmapData→Bitmap` not drawing (D5),
  `NativeWindow.bounds/title` (D7/D8), `SharedObject` domain (D11) — separate domains each.

---

## 3. Display matrix (the cases the `examples/textfield` example must cover)

"Test all TextField display situations" = turn `TextField`'s **display degrees of freedom** into a
1-D/2-D matrix, each cell producing one **diffable report line** (`adl` and AOT run the **same program,
same report format**, compared line by line).

| Dimension | Values |
|---|---|
| `type` | `dynamic` / `input` |
| `multiline` × `wordWrap` | 4 combinations |
| `autoSize` | `none` / `left` / `center` / `right` |
| `align` | `left` / `center` / `right` / `justify` |
| Text content | empty, single line, with `\n`/`\r`, long line wrapping, **trailing spaces**, leading spaces, `\t`, CJK, mixed, emoji |
| Font | `NULL` (default), `_sans`, `_serif`, `_typewriter`, `Arial`, `Helvetica` |
| Style | `size`, `color`, `bold`, `italic`, `underline`, `leading`, `kerning`, `letterSpacing` |
| Rich text | `htmlText` (`b/i/u/font/br/p/span/li`), `StyleSheet` rules, `setTextFormat` ranges |
| Password/limits | `displayAsPassword` (ASCII / CJK), `restrict`, `maxChars`, `condenseWhite` |
| Box decoration | `border`/`borderColor`/`background`/`backgroundColor`/`textColor` |
| Metrics | `textWidth`/`textHeight`/`numLines`/`maxScrollV`/`getLineMetrics` (per line)/`getCharBoundaries` |

**Report format**: one line per cell `case=<name> tw=<..> th=<..> nl=<..> lh=<..> x=<..> …`, numbers at
a fixed decimal precision (to avoid float-tail noise); `getLineMetrics` expanded per line. The two ends
are compared **line by line**; the differing lines are the items to align (harness in §5).

**Two channels**: the numeric report (§5.1, line-by-line diff, **the verdict**) plus the side-by-side
cell grid (§5.2, a visual capture of the same cases, **for the eye** — colour, the shape of bold/italic/
underline, glyph family and tab width are only visible there).

**SWC static text** gets a separate probe that needs a `.swc` (D-T1/2/3 need material); it is not put in
the material-free matrix example.

---

## 4. Integration plan (stages)

Ordered by "small change × big impact", one patch version each (AGENTS §2.7); wrap-up = full
`node test.ts` + docs + version.

| Stage | Content | Depends on | Acceptance |
|---|---|---|---|
| **T1** | **Memory safety**: write the terminator at the three `as_str_alloc(1)` sites (`TextField_ctor`, `Socket__str` ×2); add a source-level pin "an `as_str_alloc` call must fill `n+1` bytes or go through `as_str_dup("")`" | none | empty fields no longer show residue; a new `test/unit/` pin |
| **T2** | **SWC text baking**: decode `DefineEditText` (flags/`HasText`/`FontHeight`/`TextColor`/`HasFont`/`FontClass`/`Layout`/`InitialText`) and `DefineText` (`TEXTRECORD` + code table) → bake `t->text` + `t->defaultTextFormat` (incl. `align`); `SimpleButton` draws nothing when `upState==NULL` | T1 (new text must not be a dirty string) | acme-app's footer/agreement/font/alignment six sites align with `adl`; `examples/textfield` gains SWC cases |
| **T3** | **`displayAsPassword` code-unit masking** + placeholder grey | none | 5 CJK chars → 5 stars (grey); `temp/pwdhtml` contract regression |
| **T4** | **`TextFormat`: more fields + 11-param ctor** (`indent`/`blockIndent`/`leftMargin`/`rightMargin`/`bullet`/`tabStops`/`url`/`target`) | none | measure each field against `adl` before landing |
| **T5** | **Rich-text line boxes**: `getLineText` + fold a rule's `leading` into the run + run line-box contract | T4 | line heights converge on `adl` (re-measure with `temp/ssprobe`) |
| **T5b** | **Public geometry/text-query API family**: `getCharBoundaries`/`getCharIndexAtPoint`/`getLineIndexOfChar`/`getLineText`/`getFirstCharInParagraph`/`getImageReference` (expose the internal helpers as AIR shapes) | T5 (`getLineText` shares the line-box batch) | per-method `adl` probe; `examples/textfield` gains cases |
| **T6** | **Metric residuals**: `_sans`/`_serif` device metrics table, (optional) `textWidth` trailing spaces, glyph advance | none | per-size/per-string against `adl`; if not reproducible, state it in the docs |

> T2 is the "mountain" itself; T1 goes first because once T2 writes text into empty fields, **any**
> unterminated string becomes immediately visible.

---

## 5. Acceptance contract (dual-end `adl` report diff)

**Sole oracle**: `adl` (AIRSDK 51.4.1, `adl app.xml`) + the `mxmlc` reference compiler.

### 5.1 The numeric report (the verdict)

- `examples/textfield/Main.as` is the **same program** run on both ends: AOT via
  `node src/index.ts examples/textfield/Main.as --run`; `adl` via `examples/textfield/run-adl.sh`
  (`mxmlc` compiles the SWF → `adl`).
- Both ends write the report to **their own** `File.applicationStorageDirectory` (AIR:
  `~/Library/Application Support/<app-id>/Local Store/`; AOT:
  `~/Library/Application Support/as3aot/Local Store/`); the scripts collect them into
  `temp/textfield-oracle/{adl,aot}.txt` and diff line by line.
- A differing line = an item to align; backfill the §2 table item by item (`adl` runs it right ⇒ legacy
  defect; `adl` errors / has no such thing ⇒ enhancement).

**Report format contract** (both ends byte-identical, numbers at fixed precision):

```
# textfield-probe v1
case=<label> type=<..> ml=<0|1> ww=<0|1> as=<..> align=<..> font=<..> size=<..> tw=<%.2f> th=<%.2f> nl=<..>
line=<case> i=<n> asc=<%.2f> desc=<%.2f> lead=<%.2f> w=<%.2f> h=<%.2f> x=<%.2f>
```

### 5.2 The side-by-side cell grid (for the eye, never the verdict)

The report only measures **numbers** — it sees `textWidth`, but not **colour** (`textColor` /
`<font color>` / `borderColor` / `backgroundColor` never enter the report), not the **shape** of
bold/italic/underline, and not the glyphs themselves (serif vs sans, CJK fallback, the width of `\t`).
The second channel lays the same cases out as a **labelled cell grid**, one image per end, stitched
side by side.

- **Same AS3 on both ends** (`Main.as`'s ui mode); the only difference is the rasterizer (AIR's own vs
  Skia). No window, no screenshot, no process juggling: `BitmapData.draw(this)` rasterizes offscreen,
  `getPixels()` hands back the raw pixels, and they are written with an ASCII header into
  `textfield-grid.raw` (4 bytes per pixel `A,R,G,B`, straight / non-premultiplied).
- **Cell slots come from the DECLARED box, not the current one**: `autoSize` shrinks the field box and
  the two ends shrink it by different amounts (N3) — that is a **difference to look at**, not a layout
  parameter. Packing from the post-`autoSize` `height` would cut the columns at different places and the
  images would no longer line up. So the slot height uses the declared box (`autoSize` cases pinned back
  to `100×100`), while **the thin rectangle drawn is the current box** — the difference lands right on it.
- **No pixel diff**: AIR uses its own engine (SWC text also uses its embedded SWF fonts), we go through
  Skia + system fonts, so glyph outlines are *not supposed* to match pixel for pixel (§0 non-goal); a
  pixel difference is always "huge" and carries no information.
- **Alpha is composited onto white**: AIR's `draw()` is source-over (the backdrop survives under
  transparent source pixels), ours overwrites (N7), so the two alpha distributions differ; composited
  onto white they are visually equivalent.

```sh
AIRSDK_HOME=… sh examples/textfield/run-adl-ui.sh   # -> temp/textfield-oracle-ui/adl.raw
sh examples/textfield/run-aot-ui.sh                  # -> temp/textfield-oracle-ui/aot.raw
python3 examples/textfield/grid.py \
    temp/textfield-oracle-ui/adl.raw temp/textfield-oracle-ui/aot.raw \
    temp/textfield-oracle-ui/grid-cmp.png            # montage (plus the two singles)
```

`raw` header: `TFGRID 1 <W> <H>` + `\n` + `W*H*4` bytes. The directory-unit regression does **not**
switch this on (`entry-ui.as` sits in `test/examples.ts`'s `SKIP_FILES`): the numeric path should not
write a 4 MB bitmap on every run.

---

## 6. Evidence and tool index

| Category | Path |
|---|---|
| Difference report (trigger) | workspace root `acme-app-aot-vs-adl-diff.md` |
| This plan's display-matrix example | `examples/textfield/{Main.as,UiMain.as,entry.as,entry-ui.as,app.xml,run-adl.sh,run-aot.sh,run-adl-ui.sh,run-aot-ui.sh,grid.py,README.md}` |
| Dual-end reports | `temp/textfield-oracle/{adl,aot}.txt` |
| Dual-end grids | `temp/textfield-oracle-ui/{adl,aot}.raw` → `grid.py` → `grid-cmp.png` (plus `-adl/-aot.png` singles) |
| adl generic probe harness | `temp/tryadl.sh <dir>` (`mxmlc` + `adl`, fast) |
| Line-metric oracle bench | `temp/metricprobe/` (12-family matrix + leading matrix) |
| Rich-text oracle benches | `temp/ssprobe/` (`StyleSheet`), `temp/richprobe/`, `temp/pwdhtml/` |
| Font alias/metrics | `vendor/skia_glue.cc` `sk_family_alias`/`sk_air_line_metrics`, `docs/en/skia.md` §8 |
| SWC side | `docs/en/swc.md` §3.3/§9.2 F5, `src/swc.ts` `SwcText`, `src/emit.ts` `as_swc_new` |
| Generated-C index (acme-app) | `temp/acme-mac/acme-app.c`: `as_swc_new`@373915, `as_swc_build_87/93`@362987 region, `TextField_ctor`@227037, `as_tf_paragraph`@227103 |

---

## 7. Status summary

- **Inventoried**: §1's 16 capabilities ✅, §2's twelve gaps (package A 4 items + package B 8 items) + §2C's eight first-measurement findings.
- **The ruler**: both channels are in place — §5.1's numeric report (line-by-line diff, the verdict) + §5.2's side-by-side grid (for the eye).
- **Landed (see §9)**: T1 (empty-string memory safety), T2a (full `DefineEditText` decode + HTML entity
  decoding), §2E's D-T16/D-T17 (`autoSize` sizing contract + the fallback face for an uninstalled family,
  stage 168), §2F's D-T18/D-T19 (the `textWidth`/`textHeight` contract and glyph normalisation for a scaled
  field, stage 169), §2G's D-T20 (a text child's `RECT` origin goes through the placement's linear part and
  onto AIR's twip grid, stage 170), and §2C's N3.
- **Not started**: T2b (`DefineText` glyph runs), T3–T6.
- **Measured and registered only this round**: §2G's D-T21 (`TextFormat`'s "unset" field semantics plus the
  incomplete member table/constructor) — it needs its own stage (it changes the default-value path and touches
  every text example's initial layout).
- **Contract**: always align value by value against `adl 51.4.1`; never accept "looks about the same".

---

## 8. First measurement results (2026-10-14)

Tool: `examples/textfield/{Main.as,entry.as,app.xml,run-adl.sh,run-aot.sh,textfield.build.json}`.
Two commands, one per end; reports land in `temp/textfield-oracle/{adl,aot}.txt` (**79 cases**, 183/182 lines).

```
AIRSDK_HOME=… sh examples/textfield/run-adl.sh     # -> adl.txt
sh examples/textfield/run-aot.sh                    # -> aot.txt
```

**Overall**: `diff` reports **361 changed lines** (out of 365) — i.e. almost **every** line differs
(N1's `align` alone makes **every** case line differ; normalising `align` still leaves 359).
After normalising `align`, the remaining systematic differences fall into three families:

1. **Line height / metrics (D-T7/D-T11)** — nearly every case's `th` and per-line `h/asc/desc` differ
   (`_sans` 12: adl `15.5` vs us `12`; `_serif` 12: `15` vs `13`).
2. **Password masking (D-T6/N4)** — see the table above.
3. **Default read-backs (N1/N2/N3)**.

**Relation to acme-app's visual diffs**: this report measures **numbers only** and contains no SWC static
string (D-T1/2/3 need a `.swc`) — that part is compared separately by running the acme-app under
`adl` (see the difference report and environment).

> Key takeaway: **the first thing to fix is still D-T7 (`_sans`/`_serif` line height)** — it is not a small
> deviation in one API but the observable height of **every line of text**; `th`/`maxScrollV`/visible-line
> count all move with it.

### 8.1 The second channel's first image (2026-10-14)

Tool: `examples/textfield/{UiMain.as,entry-ui.as,run-adl-ui.sh,run-aot-ui.sh,grid.py}`. Each end writes
`temp/textfield-oracle-ui/{adl,aot}.raw` (**both 1240×936** ⇒ cell for cell aligned) and `grid.py`
stitches them into `grid-cmp.png`. Visible in the image but not measurable by the report:

| Cell | Difference between the ends (left adl / right AOT) | Item |
|---|---|---|
| `pwd-cjk-only` | adl **1 star**, we show **3** | N5 / D-T6 (the report only shows 12.00 vs 14.01; the image makes it obvious) |
| `embedded-tab` | adl's `\t` is visibly **wider** (`a    b` vs `a b`) | D-T11 tab contract |
| `font-sans` / `font-typewriter` | same Helvetica / Monaco, but the strokes are **visibly heavier** (rasterizer AA coverage) | glyph surface, §0 non-goal |
| `align-center-ww` / `align-right-ww` | the aligned position differs by ~8px (downstream of the text-width difference) | D-T7 |
| `auto-left` / `auto-center` | the thin rectangle (**current box**) is visibly a different size (adl shrinks to the text height) | N3 |
| The rest (`font-null` / `font-serif` / `border-bg` / `html-font-color` / `range` / `lead0` / `lead8` / `ml-wrap-on`) | **no visible difference** | — |

> This image also turned up N7 (`BitmapData.draw` does not composite) and N8 (`lineStyle(0)`, open
> question) — neither is on the TextField surface, so they are merely recorded, not touched.

---

## 9. Landed (stage 149, v0.4.120)

Working through §4's order; the first batch lands three things. All three were verified on the **real
acme-app** against `adl`.

**T1 empty-string memory safety (`emit.ts` ×2 / `runtime.ts`)**

- The contract: `as_str_alloc(n)` allocates `n` bytes on `GCT_STRING` and **does not zero** them; the caller
  writes the terminating NUL (see the `as_str_alloc` comment in `runtime.ts`). Four call sites forgot:
  `TextField_ctor`'s `o->text` and both error paths of `Socket__str`.
- Fix: new `as_str_empty()` (which writes `s[0] = 0` itself), and the four sites call it. We deliberately do
  **not** add a NUL fallback inside `as_str_alloc`: that is an extra store on the hottest string path, and it
  would turn "forgot to write" into "impossible to notice".
- Pinned by `test/unit/emit.ts`'s `unit: emit/EmptyStringTerminator`: no bare `as_str_alloc(1)` may remain in
  `src/{emit,runtime}.ts`, the generated `TextField_ctor` must write `as_str_empty()`, and both `Socket__str`
  error paths must use it.

**T2a full `DefineEditText` decode (`swc.ts` + `emit.ts`)**

- `parseSwfText` decodes all 341 text characters (338 of them tag 37) field by field: InitialText /
  FontID→FontName / FontHeight / **RGBA** TextColor / align / margins / indent / leading / Multiline /
  WordWrap / Password / ReadOnly / NoSelect / Border / HTML / MaxLength; the new `parseSwfFontName`
  (tags 48/75/91) builds the `FontID → FontName` table.
- Two **format pitfalls** (both settled by measurement on skin.swc, both documented in the code):
  ① the flags are a **MSB-first 16-bit word** — reading them little-endian as a `UI16` shifts every bit
  (the old `autoSize` was really reading `HasFontClass`); ② `TextColor` is **RGBA (4 bytes)**, not RGB —
  reading one byte short shifts the layout and the string that follow.
- `as_swc_new`'s `'text'` branch went from "build an empty box" to "build the box + stamp the
  InitialText/TextFormat/flags".
- `notes` now reports per class (tag 37 decoded / tag 11 still an empty box). `docs/{zh-cn,en}/swc.md` §10-①
  was updated to match.

**T2c HTML character-reference decoding (`emit.ts`)**

- New finding: `as_tf_html_set` decoded **no** entities at all, so acme-app's second footer line would draw
  8 literal `&nbsp;` (`D-T13`). New `as_tf_html_entity`: the named set `&amp; &lt; &gt; &quot; &apos;
  &nbsp;` plus decimal/hex numeric references (surrogate range rejected).
- Verified: three new `examples/textfield` cases align with `adl` value by value — `html-entity-nbsp`
  20.00/20.02, `html-entity-named` 55.50/55.51, `html-entity-numeric` 32.00/32.00 (the deltas are the known
  glyph-advance residual).

**Effect on the real app (acme-app → native macOS)**: the whole footer line plus `cdn.acme.example`, the
entire fix-window explanation plus the "Try to repair" caption, and the agreement paragraph (`#92`, "我已了解
并阅读《隐私政策》/《服务协议》") appear **for the first time**. Evidence image:
`temp/cmp/shots/aot_entities_login.png`.

**Still to do**: tag 11 (`DefineText`, 3 in this library) glyph runs; embedded-font outlines (family names go
through Skia system-font aliasing, so metrics carry a residual); `_sans`/`_serif` line height (D-T7); the
`displayAsPassword` setter's no-relayout contract (N4).

## 10. The second channel: side-by-side cell grid (tooling, no version number)

Contract in §5.2, measurements in §8.1. Added/changed:

| File | Purpose |
|---|---|
| `examples/textfield/Main.as` | constructor became `Main(ui:Boolean = false)`; in ui mode it lays the 42 cases out as a 4-column grid and writes `textfield-grid.raw` via `BitmapData.draw(this)` + `getPixels()` |
| `examples/textfield/UiMain.as` | the adl-side document class (mxmlc only accepts a no-arg constructor) ⇒ `super(true)` |
| `examples/textfield/entry-ui.as` | the AOT ui entry (`new Main(true)`); listed in `test/examples.ts`'s `SKIP_FILES` |
| `examples/textfield/run-adl-ui.sh` / `run-aot-ui.sh` | one `raw` per end (still the original `app.xml`: the grid is an offscreen raster and needs no window) |
| `examples/textfield/grid.py` | `raw` → PNG (alpha composited onto white) + side-by-side montage |

Nothing in the compiler's output changed (not one line of generated C or the runtime), so **no version
bump**; and the numeric path (`entry.as` ⇒ `new Main()`) writes no bitmap, so the directory unit's cost
and artefacts are unchanged.
