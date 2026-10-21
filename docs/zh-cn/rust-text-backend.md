# 文本排版后端：先把文本引擎拆出链接（已完成），再决定要不要换 Rust

> **状态：第一步已落地（阶段二百二十一，`v0.4.195 → v0.4.196`）；第二步（换 Rust 引擎）仍是评估，未实施、无版本号。**
>
> 本文回答两个问题，顺序不能颠倒：
>
> 1. **能不能让"不画文字的程序"不付文本引擎的链接钱？** ——**能，已做，已实测**：
>    把文本 glue 拆成独立源文件 / 独立对象，构建层按程序是否用到 `flash.text` 决定链不链它。
>    同一个不画文字的程序：**19.43 MB → 6.53 MB（−12.90 MB，−66.4%）**，语义零改动。
> 2. **要不要把排版引擎换成纯 Rust（cosmic-text + swash + rustybuzz）？** ——**接点现成
>   （15 个函数的不透明接缝），但值得做的场景极窄**：桌面与 web 不值得，唯一算得过账的是
>   移动端 + 体积硬约束，且真正的成本不是链接，是把 `adl` 逐值校准出来的排版口径在一个
>   算法完全不同的引擎上**重做一遍**（§9）。
>
> 旧版本（2026-10-20）把"拆成独立对象"写在 §2.4 的结论里，当作"换引擎的前置条件"。
> 实际上它**本身就是收益**，而且**不需要换引擎**——这是本文修订后最大的结构变化。

---

## 0. 范围与两步走

**第一步（已做完，本文 §1–§2）**：把 `vendor/skia_glue.cc` 里的文本段拆成
`vendor/skia_text_glue.cc`，让"不使用文本"的构建**根本不把它放进链接**。这一步不改任何
AS3/渲染语义，只改**链接图**。

**第二步（评估，本文 §4–§12）**：把 §1.1 那 15 个接缝函数的**实现**从 SkParagraph 换成
Rust 静态库。这一步会改语义，要重做全部排版校准。

**不在范围内**：`TextField` 的 AS3 语义本身（见 [`flash-text.md`](flash-text.md)）；
Skia 的整体集成与 Metal 后端（见 [`skia.md`](skia.md)）；SWC 静态文本烘焙（见 [`swc.md`](swc.md)）；
"前端 TS 要不要转 Rust"（结论见 §11）。

**唯一 oracle**：AIR 51.4.1 的 `adl`。凡本文提到"对得上/对不上"，都以 `adl` 逐值为准
（AGENTS §1.5）。

---

## 1. 现状：文本管线是四层，接缝只有一个

```
① 生成的可读 C        as_tf_*  /  TextField_*        （emit.ts 发射，唯一接触 C 字符串的地方）
        │  调用
② runtime.ts 的 inline 转发层   as_skia_text_measure / as_skia_textlayout_*
        │  runtime.ts:8927+（ASC_USE_SKIA + ASC_HAVE_TEXT）
        │  runtime.ts:9592+（无 Skia 或未链文本引擎：全 0 桩）
③ C 接缝（extern，15 个函数）   src/runtime.ts:8763–8789
        │
④ 胶水实现            vendor/skia_text_glue.cc（695 行，阶段二百二十一拆出）
        │              SkParagraph / SkFontMgr / SkTypeface / HarfBuzz / ICU
⑤ Skia 预编译库        vendor/skia/lib/<platform>/
```

### 1.1 接缝就只有 15 个函数

| 组 | 函数 | 位置 |
|---|---|---|
| 单行测量（2） | `sk_text_measure` / `sk_text_measure_n` | `runtime.ts:8767–8768` |
| 段落排版（13） | `sk_textlayout_new` / `_new_leading` / `_new_runs` / `_height` / `_max_width` / `_line_metrics` / `_line_box` / `_line_count` / `_paint` / `_delete` / `_glyph_position_at` / `_rects_for_range` / `_caret_rect` | `runtime.ts:8769–8789` |

段落是一个**不透明句柄**（`void*`），C 侧只通过上面 13 个函数查询（高/宽/行数/行盒/光标/
区间矩形）与绘制（`_paint(para, canvas, x, y)`）。**没有一处 C 结构体暴露 SkParagraph 的类型。**

> 这就是 §2.9 铁律（"第三方库链接进来，不内嵌"）的产物：正因为接缝是不透明的 15 个函数，
> ①"把实现搬去另一个源文件"和②"换引擎"才都不等于"改架构"。

### 1.2 拆开后的文件布局（阶段二百二十一）

| 文件 | 行数 | 内容 | 什么时候进链接 |
|---|---|---|---|
| `vendor/skia_glue.cc` | 1492 | **图形半边**：surface/GPU/canvas/paint/blend/path/gradient/rich-fills/filters/bitmap/SVG/图像编解码 + **平台字体管理器** | Skia 构建**总是**链 |
| `vendor/skia_text_glue.cc` | 695 | **文本半边**：`sk_default_typeface`、AIR 设备字体别名、`sk_text_measure*`、`sk_canvas_draw_text*`、全部 `sk_textlayout_*`、AIR 行盒/strut 换算 | 只有程序用到 `flash.text`（或 SWC 烘焙出文本字符）时链 |
| `vendor/skia_glue_internal.h` | 18 | 两半唯一的共享声明：`sk_sp<SkFontMgr> sk_platform_fontmgr();`（C++ 链接，**故意不 inline**） | 头文件 |

### 1.3 平台的字体管理器已经是分层的

`sk_platform_fontmgr()` 按平台分派，**留在图形半边**（理由见 §2.5）：

| 平台 | 实现 | 位置 |
|---|---|---|
| macOS | `SkFontMgr_New_CoreText(nullptr)` | `skia_glue.cc:394` |
| Windows | `SkAirFontMgr(GDI, DirectWrite)` —— 双层回退 | `skia_glue.cc:231`（类）/ `:381`（工厂） |
| web / 无平台 | `SkFontMgr_New_Custom_Empty()` → `SkFontMgr_New_Custom_Data()`（固定字体数据，FreeType 扫描） | `skia_glue.cc:143` |
| Android（未来） | Skia 现成有 `SkFontMgr_New_Android`（读 `/system/fonts` + `fonts.xml`） | 未接入 |

**这条事实很重要**：它意味着"移动端字体匹配差"**不是**引入 Rust 文本栈的理由——三端都已经
委派给系统字体管理器了。见 §8。附带结果：拆文件时字体管理器**必须留在图形半边**，否则
SVG 的 `<text>` 与 web 的字体注入会跟着文本引擎一起消失。

---

## 2. 第一步：把文本引擎拆出链接（已完成）

### 2.1 为什么"拆"是唯一出路

`vendor/skia_glue.cc` 原本是**一个** 2106 行的 `.cc`，编成**一个** `skia_glue.o`。
**对象文件是整份参与链接的**：只要它的任何一个函数引用了 `skia::textlayout::*`
（`StrutStyle`、`FontCollection`、`ParagraphBuilder`…），链接器就必须解析这些符号，于是

```
libskparagraph.a → libskunicode.a → libharfbuzz.a → libicu.a → libicu.icudtl_dat.o (10.19 MB)
```

整链被拉进来，**哪怕这个程序一行字都不画**。实测两条被否掉的路：

| 试过的办法 | 结果 |
|---|---|
| glue 加 `-ffunction-sections` + 链接加 `-Wl,-dead_strip` | **仍然链接失败**（`Undefined symbols: skia::textlayout::StrutStyle::StrutStyle()`）——对象文件即使分节，其未定义符号仍必须可解析 |
| 只给最终二进制加 `-Wl,-dead_strip` | 能少 2.74 MB，但 ICU 仍在（文本符号已经进了链接图） |

所以**拆源文件是唯一能"改链接图"的手段**：只有把引用 SkParagraph 的代码放进**另一个**
`.o`，那个 `.o` 才有可能不参与链接。

### 2.2 怎么拆的

判据只有一条：**图形半边不得出现任何 SkParagraph 符号**（`vendor/skia_text_glue.cc` 的头注释
里写着这条规矩，`test/unit/build.ts` 的 `unit: build/TextEngineSplit` 用源级断言钉住它）。

| 留在图形半边 | 搬去文本半边 |
|---|---|
| surface / GPU / canvas / paint / blend / path / gradient / rich-fills / filters / bitmap | `sk_default_typeface`、AIR 设备字体别名（`_sans`/`_serif`/`_typewriter`…） |
| SVG 光栅化（`ASC_USE_SVG`） | AIR 行盒模型（`sk_air_line_metrics` / `sk_round_half` / `sk_set_air_strut`） |
| 图像 → PNG / 图像编解码 | `sk_text_measure` / `sk_text_measure_n` / `sk_canvas_draw_text*` |
| **平台字体管理器**（见 §2.5） | 全部 13 个 `sk_textlayout_*` + `sk_family_alias` |

对称性检查：**接缝本身一个字没改**。搬动的是实现，不是接口——这正是 §1.1 那个不透明接缝
存在的意义。

### 2.3 谁决定链接哪一半：`src/index.ts::usesTextEngine`

决策必须在**生成 C 被编译之前**做出，因为 `ASC_HAVE_TEXT` 改变的是**接缝编译成什么**，
事后再看目标文件的未定义符号已经晚了（那时 C 已经编完）。所以这是一个**源级探测器**，
与既有的 `usesFlashData`（决定链不链 SQLite）同形、同偏置：

```ts
// src/index.ts:384–402
function usesTextEngine(texts: string[]): boolean {
  const re = /flash\.text\.|(?:^|[^A-Za-z0-9_.$])(?:TextField|TextFormat|TextLineMetrics|StyleSheet|
    TextFieldAutoSize|TextFieldType|TextInteractionMode|AntiAliasType|GridFitType|StaticText)(?![A-Za-z0-9_])/;
  for (const t of texts) if (re.test(t)) return true;
  return false;
}
```

四个要点：

1. **匹配"包名 + 裸类名"两种写法**：AS3 允许不 import 直接写 `new flash.text.TextField()`；
   而裸 `TextField` 必须 import 才有——两种都要抓。
2. **SWC 烘焙出的文本字符也算用户**：`swcBake.characters` 里 `kind === 'text'` 的字符会被
   烘成真正的 `TextField`，而这份 AS3 源码里**一个字都不提** `flash.text`
   （`src/swc.ts:2234` 产出 `kind: 'text'` 的字符，`:2365`–`:2446` 把它们烘成 `TextField` 子件，`swc.md` §9.2）。漏了这一条，`--air-app` 的皮肤应用会静默失去文字。
3. **清单优先**：清单**显式**写了 `vendor/skia_text_glue.cc` 就一律链（用户说了算）。
4. **源码 + 宏在同一个分支里加**，不可能只加一个——只加源码是白带的体积，只加宏是
   `undefined symbol`。

构建时打印判定，不允许静默：

```
+ flash.text: text engine linked (program uses flash.text)
- flash.text: no text in this program -- text engine NOT linked (~12.9 MB smaller)
```

### 2.4 运行时接缝：`ASC_HAVE_TEXT` 两态，且不静默降级

`src/runtime.ts:8927` 起的接缝转发层现在是三段：

| 分支 | 内容 |
|---|---|
| `#ifdef ASC_HAVE_TEXT`（Skia + 链了文本引擎） | 16 行真实转发到 `sk_*` |
| `#else`（Skia 但没链文本引擎） | 同形的 no-op 桩 + **一次性 stderr 警告** `as_text_engine_absent()` |
| `#ifndef ASC_USE_SKIA`（纯 C / WASI） | 原本就有的全 0 桩，**未改动** |

警告只在**真的被驱动**时打一次，所以"编译过、跑得动、只是没文字"这种静默形态不会发生：

```
warning: flash.text is not linked into this build, so every TextField operation is a no-op.
         The build found no flash.text class in the program's sources, so it skipped the text engine;
         rebuild with it linked (docs/zh-cn/rust-text-backend.md) if that verdict was wrong.
```

已验证过这条路的真实形态：拿一个**用文本的**程序，故意用"没有文本半边"的方式链接，跑起来
就是上面这三行 + 程序自己停在 `textWidth <= 0` 的自检上（`examples/tf-scale-metrics.as:97`）。

### 2.5 故意没搬的东西：平台字体管理器

`sk_platform_fontmgr()` **留在图形半边**，因为它是**图形层服务**，不只是文本层服务：

- SVG 光栅化（`ASC_USE_SVG`）要把它交给 `SkSVGDOM`，否则 SVG 里的 `<text>` 没字体
  （`skia_glue.cc:1431`）；
- web 构建的字体注入 `sk_fontmgr_register_data`（`skia_glue.cc:163`）改的是同一个缓存，
  而 `EXPORTED_FUNCTIONS` **无条件**导出 `_sk_fontmgr_register_data`——搬过去的话，
  一个不画文字的 web 构建会直接链接失败。

于是它成了**两半唯一的共享符号**：图形半边定义（`static` 已去掉），文本半边经
`vendor/skia_glue_internal.h` 声明后调用。头文件里那行**故意不写 `inline`**：inline 定义会
把 CoreText/GDI 管理器拽进每一个构建，正好抵消这次拆分。

### 2.6 实测

同一份程序（`temp/split/notxt.as`，只画 `Graphics`、不含任何 `flash.text`），同一个清单
（`examples/draw-over.build.json`），唯一差别是构建层现在把它判成"无文本"：

| | 二进制 | ICU 数据（`nm | grep icudt`） |
|---|---|---|
| 拆分前（同一份代码改动之前的基线） | **19,429,928 B = 19.43 MB** | 有（`_icudt69_dat`） |
| 拆分后 | **6,531,688 B = 6.53 MB** | **无** |
| 拆分后但 `-O0` 编生成的 C（证明不依赖 `-O2` 死代码消除） | 6,809,608 B，链接通过 | 无 |

- 省下 **12,898,240 B（−66.4%）**，其中 ICU 数据块 10.19 MB、其余 ≈2.7 MB 是
  skunicode + harfbuzz + skshaper + skparagraph 的代码。
- **用文本的程序不变**：`examples/tf-scale-metrics.as` 仍是 19,430,208 B（判成"有文本"）。
  也就是说这一刀切的是"**不用文本**"这一侧，不是"少给文本功能"。
- 生成的 C **一个字节都没变**（拆的是 C++ 侧）——所以既有示例的数值断言全部原样通过。
- `-O0` 那一行是**刻意的**：如果新链接只在 `-O2` 把死分支剪掉之后才成立，那就说明我们
  依赖了优化器而不是链接图，换个 `opt` 就会炸。

**web 目标同样成立**（`--target wasm --package web`，同一份清单、只有判定不同）：

| | `.wasm` | 判定 |
|---|---|---|
| 不画字的小程序 | **2,769,084 B = 2.77 MB** | `- flash.text: ... text engine NOT linked` |
| 同上改用 `TextField` | **5,846,710 B = 5.85 MB** | `+ flash.text: text engine linked` |

差 3.08 MB 就是 web 侧的 ICU + 整形栈。这两行同时反证了 §2.5 那条决定：**不画字的那份没有链文本
半边，却仍然导出了 `_sk_fontmgr_register_data`**（`EXPORTED_FUNCTIONS` 无条件要它）——字体管理器
若搬去文本半边，这个构建会直接链接失败。两个 `--air-app` 示例（`air-starling-demo` 8.97 MB、
`air-native` 7.43 MB）也已实编通过。

### 2.7 这次拆分的四个坑（都写进注释了）

| 坑 | 症状 | 处理 |
|---|---|---|
| `RUNTIME_PREAMBLE` 是**反引号模板串** | 在 C 注释里写反引号 → TS 直接语法错（`ERR_INVALID_TYPESCRIPT_SYNTAX`） | 注释里不出现反引号 |
| 同上，`\n` 会被 JS 先吃掉 | `fprintf(stderr, "...\n")` 在生成的 C 里变成真换行 + 断串 | 源里写 `\\n` |
| 单元钉子按"单个 glue 文件"读源码 | 5 个组（`display`/`render`/`text-input`/`platform`/`build`）在文本代码搬走后全红 | `test/harness.ts` 加 `readGlue()`（两文件拼接）；**拆分本身**由新组 `unit: build/TextEngineSplit`（13 条）单独钉 |
| 把 `sk_platform_fontmgr` 改成非 `static` 后，`platform/FontFallback` 的锚点串失效 | 断言 `#else\nstatic sk_sp<SkFontMgr> sk_platform_fontmgr()` 找不到 | 锚点同步去掉 `static`，并在组里注明"两半共享"的理由 |

---

## 3. 第二步的账：拆完之后还剩多少

拆分把"画不画文字"的差**明确化**了：现在它是一笔**可选的 12.90 MB**，而不是"人人有份"。
剩下可做的，按"风险 / 收益"排序：

| 路线 | 做法 | 预期收益 | 风险 | 状态 |
|---|---|---|---|---|
| **L0** | **本次拆分**（不用文本 → 不链文本栈） | **−12.90 MB**（对不用文本的构建） | 已消化 | ✅ **已完成** |
| **L1** | 链接期 `-Wl,-dead_strip`（`build.ts` 里 `grep` 不到） | **−2.74 MB**（全构建） | 低（ObjC 类别 / typeinfo 在 `-dead_strip` 下需全量回归验证） | ⏸ 未做（§10） |
| **L2** | Skia 重编：`skia_use_icu=false` + `skia_use_icu4x=true` | 可能砍掉 10.19 MB 的大部分 | 中（需验 SkParagraph 的断行/bidi 仍对） | ⏸ 未做 |
| **L3** | Skia 重编：`skia_use_libgrapheme=true` + `skia_use_icu=false` | 同上，更激进 | 高（libgrapheme **不做 bidi**） | ⚠️ 一般不建议 |
| **L4** | 裁 `air-app.ts` 里 1:1 列出的 codec（`skottie`/`svg`/`dng_sdk`/`piex`/`expat`） | ~2.5 MB | 低 | 部分被 L1 覆盖 |
| **L5** | **换 Rust 文本引擎**（本文第二步） | 对**用文本**的构建再省 ~13 MB | **高**（§9 B1/B2） | ⏸ 只在移动端 + 体积硬约束时 |

**这张表的读法**：L0 已经拿到最大的一笔，而它**不需要碰任何排版语义**。L5 的收益与 L0
**不叠加**——L0 省的是"不用文本的程序"，L5 省的是"用文本的程序剩下的那 13 MB"。只有当
"用文本 + 体积硬约束"同时成立时，L5 才进入视野。

---

## 4. 候选技术栈（Rust 侧）

| crate | 职责 | 对应现在是谁 | 备注 |
|---|---|---|---|
| `rustybuzz` | **整形（shaping）** | HarfBuzz | **是 HarfBuzz 的 Rust 移植** ⇒ 整形行为同源、迁移风险低，但"去掉 HarfBuzz"实际上是"换成 HarfBuzz 的 Rust 版" |
| `ttf-parser` | 字体解析 / cmap / 度量 | FreeType + SkTypeface | |
| `swash` | **光栅化 + 字形缓存** | SkScalerContext + SkGlyphCache | 彩色 emoji（CBDT/sbix）支持偏弱 |
| `fontdb` | 字体枚举 / 家族匹配 | `SkFontMgr` | 三端平台字体管理器已覆盖，见 §1.3 |
| `cosmic-text` | **断行 + 段落 + 缓存** | SkParagraph（UAX#14） | 依赖以上全部 |
| `parley`（备选） | 断行 + 段落 | SkParagraph | 与 `swash` 同属 linebender，更活跃 |

**关键取舍**：整形用 `rustybuzz` 意味着"语义同源"（对 AIR 对齐有利），但**省不掉整形逻辑本身**；
真正省掉的只有 **ICU 的 unicode 数据表**（10.19 MB）与 HarfBuzz/C++ 那份实现。

---

## 5. 接入形态（三档）

| 档 | 做法 | 判断 |
|---|---|---|
| **1. 整体替换**：Rust 出 `(mask, x, y)`，C++ 只做 Skia 画布合成 | 在 `vendor/` 新增一个实现同名 13 个 `sk_textlayout_*` 的 shim，与 `skia_text_glue.cc` 里的实现**二选一编译**；生成的 C 一行不改 | ✅ **推荐**（唯一能兑现 L5 目标的形态） |
| 2. 只换字体库（`fontdb` 喂给 `SkFontMgr_New_Custom_Data`） | 只换"家族匹配" | ❌ 平台 FontMgr 已覆盖（§1.3），收益 ≈ 0 |
| 3. 双后端并行（Skia 与 Rust 同时链，运行时切换） | A/B 用 | ⚠️ 只适合**暂时性**验证：两份字体栈同时进二进制，体积反而最大 |

**为什么档 1 仍然需要 C++**：`_paint` 的落点是 **Skia 的 `SkCanvas`**（`sk_textlayout_paint(para,
canvas, x, y)`）。Rust 侧把字形光栅成 alpha mask 之后，仍要有人把它合成到 Skia 画布上
（`SkImage::MakeRasterCopy` / `SkSurface`）。所以正确的切法是：

```
Rust：整形 + 断行 + 光栅 → (glyph mask, x, y)      ← 纯 Rust，无 ICU / 无 HarfBuzz
C++ shim：mask → SkImage → canvas->drawImage        ← 仍是 Skia，但只剩"贴图"
```

---

## 6. 具体接入步骤

### 6.1 Rust crate

```toml
# vendor/rust/textlayout-rs/Cargo.toml
[lib]
crate-type = ["staticlib"]          # → libtextlayout_rs.a
[profile.release]
panic = "abort"                     # 不带 unwind 运行库，省体积且与本仓 setjmp 异常模型不冲突
opt-level = "z"
lto = true
codegen-units = 1
```

```rust
// 与 15 个接缝一一对应的 C ABI（节选）
#[no_mangle] pub unsafe extern "C" fn rtl_text_measure(t: *const c_char, size: f64, b: c_int, i: c_int) -> f64 { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_new_runs(…) -> *mut Layout { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_height(p: *const Layout) -> f64 { … }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_line_metrics(p: *const Layout, …) -> c_int { … }
// 光栅结果交给 C++ 合成
#[repr(C)] pub struct RtlGlyph { pub x: f32, pub y: f32, pub w: u32, pub h: u32,
                                 pub stride: u32, pub mask: *const u8 }
#[no_mangle] pub unsafe extern "C" fn rtl_layout_glyphs(p: *const Layout, out: *mut RtlGlyph, cap: u32) -> u32 { … }
```

### 6.2 C++ shim `vendor/textglue_rs.cc`

实现**同名**的 13 个 `sk_textlayout_*`，内部转 `rtl_*`；`paint` 把 mask 包成 `SkImage` 再
`drawImage`。与 `skia_text_glue.cc` 里那 13 个实现用**编译宏二选一**（同一符号不能有两份
定义）——`metal_glue.mm` / `d3d_glue.cc` / `stage3d_webgl.cc` 已经是这个模式（§2.9）。

> **前置条件已就绪**：旧版本文档在这里写着"同时必须把 `skia_glue.cc` 的文本段切出去，
> 否则只要它还引用 SkParagraph，ICU 就还在"。**这一步在阶段二百二十一已经做完**（§2）——
> 现在替换后端 = 换掉 `vendor/skia_text_glue.cc` 这**一个**翻译单元，图形半边不受影响，
> 也就不会被拉回 ICU。这是拆分给第二步留下的最大便利。

### 6.3 构建清单（已有的 `objects` 字段就够）

```json
{
  "objects": ["../../vendor/rust/libtextlayout_rs.a"],
  "defines": ["ASC_TEXT_RUST=1"],
  "link-paths": ["../../vendor/skia/lib/macos-arm64"]
}
```

字段定义在 `src/build.ts:168–205`（`objects?: string[]` 在 `:204`）；`objects` 落到 `build.ts:738`。**不需要新增任何清单字段。**
新宏 `ASC_TEXT_RUST` 应当与 `ASC_HAVE_TEXT` **同源**地打开（`src/index.ts::usesTextEngine`
那一处），否则又会出现"引擎在、接缝是桩"或反之的两套真相。

### 6.4 链接顺序天然正确

`build.ts:734–741` 的顺序是：`生成 .c → sources（我们的 .cc） → objects（rust .a） → -L → -l →
-framework`。静态归档正好排在"引用它的目标文件"之后——这正是 `build.ts:743` 那条注释
（*"Static-archive order: libraries must follow the objects that reference them"*）在管的约定。

### 6.5 `--air-app` 的自动检测点

`auto-app` 已有同构先例：`detectText`（`air-app.ts:168`）、`detectStage3D`（`air-app.ts:110`）、
`detectAudio`（`air-app.ts:180`）、`findAppFonts`（`air-app.ts:827`）。
**注意**：阶段二百二十一选的判定位置是 `src/index.ts::usesTextEngine`（源级扫描 + SWC 烘焙 +
清单覆盖），而不是 `air-app.ts` 的另一个 `detect*`——因为"要不要文本引擎"对**所有**构建形态
（裸 `.as`、`--manifest`、`--air-app`、web）都是同一个问题，只写在 `air-app` 里会让另外三条
路径各长一套。第二步若真做，`ASC_TEXT_RUST` 应挂在同一个判定上。

### 6.6 交叉编译矩阵（**真正的工作量在这**）

每个 target 一份 `.a`，对标 `vendor/skia/lib/{macos-arm64,wasm,windows-x64,windows-x86}` 的布局：

| target | Rust target triple | 链接器 | 现状 |
|---|---|---|---|
| macOS arm64/x64 | `aarch64-apple-darwin` / `x86_64-apple-darwin` | `clang++` | ✅ 本机可编 |
| Windows x64/x86 | `x86_64-pc-windows-msvc` / `i686-pc-windows-msvc` | `clang`（MSVC ABI） | ⚠️ 必须与 Skia 一样用 **MSVC ABI**（见 `vendor/provision/README.md` 的硬约束） |
| web | `wasm32-unknown-emscripten` | `emcc` | ✅ 有该 target |
| WASI | `wasm32-wasip1` | `clang --target=wasm32-wasip1` | 无 GUI，不必 |
| iOS（规划） | `aarch64-apple-ios` | `clang` | 待 target 落地 |
| Android（规划） | `aarch64-linux-android` | NDK clang | 待 target 落地 |

### 6.7 建议分阶段（如果要真做）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | ~~先做 §3 的低风险项~~：**L0 已完成**；余下 `-dead_strip`（L1）与 `icu4x`（L2） | 体积 + 全量回归 |
| P1 | 桌面 **A/B 双后端**（档 3）：同一份 `textfield` 示例跑两遍，用 `adl` 双端报告 diff 出**差异清单** | `flash-text.md` §5.1 数值报告 |
| P2 | 按差异清单逐项校准；差异收敛后切默认 | 差异清单归零（或如实登记） |
| P3 | 移动端 target 落地时，只在该 target 打开 Rust 后端 | 按 target 分层（`compile.md` §4.1） |

---

## 7. 逐端分析

### 7.0 总表

| 端 | 状态 | 现在谁在做文本 | 换 Rust 的**收益** | 换 Rust 的**代价/风险** | 结论 |
|---|---|---|---|---|---|
| **macOS native** | ✅ 已上线 | CoreText（字体）+ SkParagraph（排版）+ 本仓 CoreText 补丁 | 体积 ~13 MB | 丢掉 `skia.md` §6.9 的补丁收益、emoji（Apple Color Emoji）、全部 adl 校准 | ❌ 不做 |
| **Windows native** | ✅ 已上线 | GDI + DirectWrite 双回退 + Uniscribe 整形 | 体积 ~13 MB | 要自建 DirectWrite 等价回退链；emoji（Segoe UI Emoji） | ❌ 不做 |
| **Linux native** | ⛔ 未 provision | —（`vendor/skia/lib/` 无 linux） | — | — | ⛔ 无对象 |
| **web (emcc)** | ✅ 已上线 | `SkFontMgr_New_Custom_Data` + 运行时注入 `font-urls` | 体积（wasm 文本栈归档 22.1 MB；`.wasm` 首屏体积可省 ~7 MB 量级） | 字体注入契约要重做；但**首屏体积收益相对量级最大** | ⚠️ **最有价值的一档** |
| **WASI (raw)** | ✅ 已上线（无 GUI） | **无**（`as_skia_*` 全 0 桩，`runtime.ts:9592+`） | 0 | 0 | ⛔ 不涉及 |
| **iOS**（规划） | ❌ 未开始 | 计划 CoreText（补丁已覆盖 iOS 分支） | 体积 + 纯静态库形态**天然适配**（iOS 无 `dlopen` 问题） | 需先有 target、有 Skia 的 ios 构建 | ⏸ 随 target 一起评估 |
| **Android**（规划） | ❌ 未开始（`--package android-project` 直接报错，`index.ts:1060`） | 计划 `SkFontMgr_New_Android` | 体积（APK 敏感）+ 不必自建 `fonts.xml` 解析 | 同 iOS | ⏸ 随 target 一起评估 |

> **阶段二百二十一之后，web 这一档的账变了**：不画文字的 web 构建现在已经不链文本栈，
> `.wasm` 直接小一截；而"画文字"的 web 构建仍背着 22.1 MB 归档里被拉进来的那部分。
> 所以 L5 的 web 收益从"所有页面"缩小到"用文字的页面"——**触发条件更窄了，不是更宽了**。

### 7.1 macOS native

- **现在**：`SkFontMgr_New_CoreText` 枚举系统字体；SkParagraph 排版；**外加一处本仓对第三方库
  的补丁**——`vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch` 修的是 CoreText 在
  "同族同 PS 名"的两个字体文件之间换脸（`skia.md` §6.9、`flash-text.md` D-T15）。修后墨掩码对
  `adl` IoU 100%。
- **换 Rust 后**：这条补丁的收益自动消失（Rust 侧不走 CoreText），但会引入自己的字体匹配问题；
  Apple Color Emoji 的彩色渲染由 CoreText 提供，`swash` 在 CBDT/sbix 上偏弱。
- **体积**：~13 MB。
- **结论**：❌ **不做**。收益是纯体积，代价是已经钉住的全部行为。

### 7.2 Windows native

- **现在**：`SkAirFontMgr(GDI, DirectWrite)` 双层回退（`skia_glue.cc:231`），
  GDI 后端用 Uniscribe 整形（`air-app.ts:676` 注释）。Skia 库有 x64/x86 两套。
- **换 Rust 后**：要自建等价回退链（`fontdb` 读 `C:\Windows\Fonts` 可行，但 DirectWrite 的
  script-aware fallback 要自己写）；emoji 走 Segoe UI Emoji。
- **体积**：~13 MB（41.4 MB 归档 → 约 13 MB 可省，量级同 macOS）。
- **结论**：❌ **不做**，理由同 macOS。

### 7.3 Linux native

- `vendor/skia/lib/` 只有 `macos-arm64` / `wasm` / `windows-x64` / `windows-x86`，
  **没有 linux**（`compile.md` §2 明确"预编译依赖库四套"）。所以 Linux 端目前**没有可分析的文本栈**。
- 若将来 provision Linux：Skia 侧会用 fontconfig（`skia_use_fontconfig` 现在 = `false`），
  Rust 侧的 `fontdb` 在 Linux 上反而更简单。这条留到 Linux target 立项时再说。

### 7.4 web / wasm（emcc）

- **现在**：`SkFontMgr_New_Custom_Empty` → `SkFontMgr_New_Custom_Data`，字体字节由页面 JS
  `fetch` 后经 `Module._sk_fontmgr_register_data(ptr, len)` 注入（`html5-web.md` §4）。
  `EXPORTED_FUNCTIONS` 必须导出该入口（`html5-web.md` §5.2）——**这也是它必须留在图形半边的原因**（§2.5）。
- **这里有一个 web 独有的坑**：沙箱**没有可枚举的系统字体**；`font-urls` 为空 ⇒
  `sk_platform_fontmgr()` 停在 `Custom_Empty` ⇒ **drawString 一个字形都不画**，而编译成功、
  页面能跑、trace 全正常（静默错误，`html5-web.md` §4 的失败形态说明）。
- **换 Rust 后**：字体注入契约要重做一遍（同样的字节要经 wasm 边界交给 Rust 侧），
  但**接缝可以保持同形**：仍是"JS fetch → 注入 → 排版前必须就位"。
- **收益**：wasm 文本栈 22.1 MB 归档 → 大约能省 7 MB 量级。**`.wasm` 体积是首屏下载成本**，
  所以这一档的体积收益**比桌面更值钱**。
- **结论**：⚠️ **如果真要做 Rust 文本后端，这是第一顺位**（但要先把 §3 的 L1/L2 比过，
  并按 §7.0 的注记先确认"页面确实用文字"）。

### 7.5 WASI（`--target wasm --package raw`）

- **不涉及**：WASI 产物是无 GUI 的命令行模块，不含渲染。纯 C 分支下所有
  `as_skia_text_*` 都是**返回 0/NULL 的 inline 桩**（`runtime.ts:9592+`）。
- 换任何文本引擎都不影响 WASI。**0 收益、0 代价。**

### 7.6 iOS（规划）

- `compile.md` §6.1 已把 `--target ios` 列为**规划**取值（`clang --target=arm64-apple-ios`）。
- **Rust 在 iOS 上的形态反而是加分项**：iOS 扩展/组件是**静态链进应用镜像**的，没有 `dlopen`
  这一步（`TODO.md` 的 ANE 条目已记录 iOS 与 macOS 的这一差别）。Rust `staticlib` 正好是这个形态。
- 但字体侧：iOS 也是 CoreText，`skia.md` §6.9 的补丁**已经在 `SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS`
  分支内**——也就是说 iOS 上 Skia 侧的字体匹配已经被我们修好了。
- **结论**：⏸ 不要独立立项，**随 `--target ios` 一起评估**。

### 7.7 Android（规划）

- `--package android-project` 现在**直接抛错**（`src/index.ts:1060`：`not yet implemented`），
  `vendor/skia/lib/` 也没有 android 目录。
- 字体侧：Skia 有现成的 `SkFontMgr_New_Android`（读 `/system/fonts` + `fonts.xml`），
  比自己在 Rust 里解析 `fonts.xml` 更省事 ⇒ **字体匹配同样不是理由**。
- **结论**：⏸ 唯一可能让 Rust 文本后端"划算"的场景是 **APK 体积硬约束**（应用商店限制）。
  届时形态应为：**只在该 target 打开**，走 `targets.android` 清单分层（`build.ts:355–396`，
  语义是**替换而非追加**）。

---

## 8. 优势清单（逐条）

| # | 优势 | 量级 / 证据 | 适用端 |
|---|---|---|---|
| A1 | **砍掉 ICU 数据块** | 10.19 MB 单对象，见 §3 | 全端 |
| A2 | **砍掉 skunicode + harfbuzz + skshaper + paragraph** | 合计 ≈2.7 MB（本次拆分实测：省下的 12.90 − ICU 数据 10.19） | 全端 |
| A3 | **纯 Rust 无 C++ 依赖** | 消除 `SK_TRIVIAL_ABI` / `-std=c++17` / MSVC ABI 互链等约束（`html5-web.md` §5.1、`provision/README.md`） | 全端 |
| A4 | **静态库形态适配移动端** | iOS 无 `dlopen`，静态链是唯一形态 | iOS / Android |
| A5 | **整形语义同源** | `rustybuzz` 是 HarfBuzz 的 Rust 移植 ⇒ 迁移风险低于换一门新整形器 | 全端 |
| A6 | **单一引擎跨全端** | 现在 macOS/Windows/web 是**三套**字体管理器 + 两条整形路径 | 全端 |
| A7 | **`cargo` 可复现构建** | 对比 `build-tools/skia-src` 的 gn+ninja 重编（`skia.md` §6.1） | 全端 |
| A8 | **链接图已经就位** | 阶段二百二十一把文本段独立成 `vendor/skia_text_glue.cc`：换引擎 = 换这一个翻译单元，图形半边不受影响 | 全端（本次拆分的副产品） |

## 9. 劣势与代价清单（逐条）

| # | 代价 | 具体是什么 | 严重度 |
|---|---|---|---|
| B1 | **`adl` 校准全部重做** | `flash-text.md` §2 的 D-T1…D-T21 + `skia.md` §8 那一整段：断行阈值恒 `ceil(ink+4)`、`autoSize` 只 `wordWrap=false` 才改宽、`textWidth` 尾空格口径、字段被缩放时 `textWidth/Height` 的 `sy/sx` 口径、字形只按累积 `scaleY` 缩放……这些**全部钉在 SkParagraph 的行为上** | 🔴 **最贵** |
| B2 | **行盒模型要重推** | `sk_air_line_metrics` + `sk_round_half` + `sk_set_air_strut`（`skia_text_glue.cc:123–168`）——AIR 是 `rhalf(ascent)+rhalf(descent)+leading(px)`、**永不加 line gap**；Skia 是 `ceil(ascent+descent+lineGap)`。这套换算对九个具名字体逐值命中，换引擎后要从零重推 | 🔴 |
| B3 | **字体别名语义** | `sk_family_alias`（`skia_text_glue.cc:225`）：`_sans→Helvetica`、`_serif→Times New Roman`、`_typewriter→Monaco`、`NULL→Times`，以及"**未安装的字族回落到平台默认脸**"（`D-T17`，实测差 6 px） | 🟠 |
| B4 | **彩色 emoji** | `swash` 在 CBDT/sbix 位图彩色字体上偏弱；而 CoreText（macOS）、DirectWrite（Windows）都现成支持 | 🟠 |
| B5 | **可装上的字体 ≠ 可枚举的字体** | web 侧的注入契约要重做（§7.4）；native 侧要重建平台回退链 | 🟠 |
| B6 | **丢字形缓存/性能** | 现在 `SkGlyphCache` + Skia 的 glyph atlas 是免费的；Rust 侧要自建（`swash` 有 `scale::Scaler`，但缓存要自己管） | 🟡 |
| B7 | **`skia.md` §6.9 的补丁收益消失** | 那条补丁修的换脸问题在 Rust 侧换一种形式重现（要自己处理"同族同 PS 名"） | 🟡 |
| B8 | **工具链进 CI** | 当前**本机没有 Rust 工具链**（`rustc`/`cargo`/`rustup` 均 `command not found`）；CI 要加 5~6 个 target 的交叉编译 | 🟡 |
| B9 | **许可证核对** | Skia=BSD-3、ICU=Unicode License；Rust 侧 `cosmic-text`/`swash`/`fontdb`/`rustybuzz`/`ttf-parser` 的许可证需逐项核对后再定（**本文未核对**，落地前必查） | 🟡 |
| B10 | **双后端期体积最大** | 档 3（A/B 并行）时期，两份字体栈同时在二进制里 | 🟡 |
| B11 | **全套回归要重跑** | 200+ 示例 + `textfield` 双端报告 + `[textwrap]` 等结构钉 | 🟡 |

### 9.1 B1/B2 的实证：这些口径是什么样子

`vendor/skia_text_glue.cc` 的 695 行里，**大部分行数不是"画字"，而是"把 Skia 拽到 AIR 的口径上"**：

```cpp
// AIR 把 line box 的每一半各自四舍五入到 0.5，且永不加字体自身的 line gap；
// Skia 报的是 ceil-ish(ascent + descent + lineGap)。
// 实测（Helvetica 9.24→9 / 2.76→3；Times New Roman 10.6875→10.5 / 2.59375→2.5），
// 四舍五入两半复现了每个具名字体的行高：Courier 12、Courier New 13.5、Menlo 14、
// Monaco 15、Times 12、Times New Roman 13、Arial 13.5、Helvetica 12、Geneva 15。
static double sk_round_half(double v) { return floor(v * 2.0 + 0.5) / 2.0; }
                                                 // skia_text_glue.cc:123
```

```cpp
// StrutStyle::leading 在这个构建里根本到不了 line box（实测 leading=4 时两行段落仍是
// 2*model），而且负 leading 会被 Skia 直接 clamp 到 0；所以 leading 必须折进 height。
// 又因为 Skia 按 (height * fontSize / rawFull) 缩放，height 要预乘 rawFull/rawSum。
strut.setHeight((SkScalar)(box * am.rawFull / (am.rawSum * size)));   // skia_text_glue.cc:168 起
```

这两处**不是可以"翻译"的东西，是必须重新用 `adl` 逐个探针量出来的东西**。B2 的严重度由此而来。

---

## 10. 横向对比：拆分之后还能怎么瘦身

**L0 已经落袋（§2.6）**，剩下三档互不冲突，成本相差一个数量级：

| 路线 | 做法 | 预期收益 | 风险 | 建议 |
|---|---|---|---|---|
| **L1** | 链接期 `-Wl,-dead_strip`（当前完全没有） | **实测 −2.74 MB**（19.43 → 16.69，`temp/textsize/notxt_ds`） | 低（需全量回归验 ObjC 类别/typeinfo） | ✅ **下一步先做** |
| **L2** | Skia 重编：`skia_use_icu=false` + `skia_use_icu4x=true` | 可能砍掉 10.19 MB 的大部分（ICU4X 数据是**模块化、可裁剪**的，且 ICU4X 本身是 **Rust**） | 中（需验 SkParagraph 的断行/bidi 仍对；`build-tools/skia-src` 已有重编流程） | ✅ **L1 之后立刻做** |
| **L4** | 裁 `air-app.ts` 里 1:1 列出的 codec（`skottie`/`svg`/`dng_sdk`/`piex`/`expat`） | ~2.5 MB | 低 | 已被 L1 部分覆盖 |

> L2 值得强调：**ICU4X 是 Rust**。也就是说"用 Rust 的 unicode 库"这个想法**不必**通过替换
> 整个文本引擎来实现——Skia 自己就留了 `skia_use_icu4x` 这个开关，代价只是重编一次 Skia。
> **先用 L2 把 ICU 数据块换掉，再决定要不要动文本引擎。**

`build-tools/skia-src/out/{macos-arm64,wasm}/args.gn` 现状（两个文件一致）：

```
skia_use_icu = true
skia_use_icu4x = false          ← ICU4X 本身是 Rust 的模块化 unicode 库
skia_use_libgrapheme = false
skia_use_harfbuzz = true
skia_enable_skparagraph = true
skia_enable_skshaper = true
```

---

## 11. 顺带澄清："那前端 TS 要不要转 Rust"

**两件事，不要混。**

| 问题 | 含义 | 影响 | 结论 |
|---|---|---|---|
| A. 产物是什么语言 | 生成 C → 生成 Rust | 运行时架构、体积、语义 | ❌ 不采（有环 GC / `setjmp` 异常 / "可读 C" 三条硬伤） |
| B. 编译器用什么写 | 前端 TS → Rust | 只影响编译器自身的分发 | ❌ 不采（~55k 行可移植，运行时那份 736 KB C 原样保留 ⇒ "转了 Rust 仍生成 C"） |
| C. **本文的**：把某个**原生组件**换成 Rust 静态库 | `vendor/` 多一个 `.a` | 体积 / 免 Node | ⏸ **唯一正当形态，且只在移动端 + 体积硬约束时** |

C 与前两者**正交**：它不碰生成的 C、不碰前端、不碰运行时——只在 `vendor/` 加一个静态库，
经构建清单的 `objects` 链接。这也正是 §2.9 允许的形态。

---

## 12. 触发条件与决策树

```
体积是硬约束？
├─ 否 ──────────────────────────► 不做 L5。文本栈 ≈13 MB 是"能忍"的成本，
│                                 而 §9 B1/B2 的重校准成本远大于收益。
│                                 （但 L0 已经让不画文字的构建白赚 12.9 MB。）
└─ 是
   ├─ 该构建画文字吗？
   │  ├─ 否 ──► 已经自动解决（阶段二百二十一），不需要任何人做决定。◄── 已落袋
   │  └─ 是
   │     ├─ 该端有 Skia 的预编译库可重编？
   │     │  ├─ 是 ──► 先做 L1(-dead_strip) + L2(icu4x)。到这一步通常已经够了。◄── 推荐终点
   │     │  └─ 否 ──► 先 provision（Linux/Android 都还没 Skia 库）
   │     └─ L1+L2 之后仍不够？
   │        └─ 是 ──► 才轮到 L5（Rust 文本引擎），
   │                  且**只在该 target 打开**（targets.<target> 分层，替换语义）
```

**具体触发**（三条同时成立才启动 L5）：

1. `--target ios` 或 `--target android` **已落地**（现在是"规划"，`compile.md` §6.1）；
2. 该端的**体积被外部硬约束**（应用商店 / 首屏预算）；
3. L1 + L2 已执行且**仍不达标**，并留下实测数据。

---

## 13. 附录

### A. 15 个接缝函数（现状全清单）

接缝声明：`src/runtime.ts:8763–8789`；实现：`vendor/skia_text_glue.cc`（`ASC_HAVE_TEXT` 才进链接）。

| # | 函数 | 签名要点 | 实现位置 |
|---|---|---|---|
| 1 | `sk_text_measure` | `(text, size, bold, italic) → double` | `skia_text_glue.cc:308`（`SkFont::measureText`） |
| 2 | `sk_text_measure_n` | 同上 + 显式字节数 | `skia_text_glue.cc:315` |
| 3 | `sk_textlayout_new` | 平文单样式 | `skia_text_glue.cc:373` |
| 4 | `sk_textlayout_new_leading` | + `leading` | `skia_text_glue.cc:411` |
| 5 | `sk_textlayout_new_runs` | **富文本**（`sk_text_run[]`） | `skia_text_glue.cc:465` |
| 6 | `sk_textlayout_height` | 段高 | 同文件 |
| 7 | `sk_textlayout_max_width` | 最长行宽 | 同文件 |
| 8 | `sk_textlayout_line_metrics` | 逐行 start/end/top/bottom | 同文件 |
| 9 | `sk_textlayout_line_box` | 单行 ascent/descent/left/width | `skia_text_glue.cc:640` |
| 10 | `sk_textlayout_line_count` | 行数 | 同文件 |
| 11 | `sk_textlayout_paint` | **绘制到 SkCanvas** | 同文件 |
| 12 | `sk_textlayout_delete` | 释放 | 同文件 |
| 13 | `sk_textlayout_glyph_position_at` | 点击 → 字符索引 | 同文件 |
| 14 | `sk_textlayout_rects_for_range` | 区间 → 矩形集合（选区/下划线） | 同文件 |
| 15 | `sk_textlayout_caret_rect` | 光标矩形 | 同文件 |

> 另有 **`sk_text_run` 结构体**（`runtime.ts:8594–8596`）**无条件定义**（纯 C 构建也要用）；
> 以及 `sk_canvas_draw_text` / `sk_canvas_draw_text_n` 两条**直接绘制**路径
> （`skia_text_glue.cc:291` / `:300`），它们绕过 SkParagraph，只做单行。

### B. 本机实测数据

**B.1 拆分前后（2026-10-21，macOS arm64，`temp/split/`）**

| 项 | 字节 | 说明 |
|---|---|---|
| `notxt` 拆分前基线 | 19,429,928 | `examples/draw-over.as` 清单，文本段与图形段同一个 `.o` |
| `notxt2` 拆分后 | **6,531,688** | 判成"无文本"，只链 `skia_glue.o` |
| `notxt_o0` | 6,809,608 | 生成的 C 用 `-O0` 编，证明链接不依赖死代码消除 |
| `tf`（用文本，拆分后） | 19,430,208 | `examples/tf-scale-metrics.as`，判成"有文本"，与基线同量级 |
| `tf_notxt`（故意不链文本半边） | 6,548,376 | 跑起来打 §2.4 那三行警告，程序自检停在 `textWidth <= 0` |

**B.2 拆分前的原始测量（2026-10-20，`temp/textsize/`）**

| 项 | 值 | 复现 |
|---|---|---|
| 无 Skia 基线二进制 | 0.81 MB | `node src/index.ts examples/hello.as -o temp/textsize/hello` |
| 最小 Skia 程序（不链 glue） | 5.69 MB，**无 ICU 数据** | `temp/textsize/min.cc` + `temp/textsize/minA` |
| 文本示例二进制 | 19.43 MB（`__const` 10.79 MB，含 `_icudt69_dat`） | `temp/textsize/probe`（源 `examples/textflow.as`） |
| **图形示例**（无文本）二进制 | **19.43 MB**（同上） | `temp/textsize/notxt`（源 `examples/draw-over.as`） |
| 同上 + `-Wl,-dead_strip` | 16.69 MB | `temp/textsize/notxt_ds` |
| 同上 + glue `-ffunction-sections` + `-dead_strip` | 16.69 MB（ICU 仍在），且**另一份不带 `-dead_strip` 的组合直接链接失败** | `temp/textsize/notxt_fs` |
| `libicu.icudtl_dat.o` | **10.19 MB（单对象）** | `ar tv vendor/skia/lib/macos-arm64/libicu.a` |
| Rust 工具链 | **未安装**（`rustc`/`cargo`/`rustup` 全部 `command not found`） | — |

> 测量口径：`ls -l` 取字节数 / `size -m` 取段与节大小 / `nm | grep _icudt69_dat` 判 ICU 数据是否进包。
> **本表统一用十进制 MB（10^6）**。旧版本文档里的 "18.53 MB / 15.91 MB / 9.71 MB" 是同一批产物的
> MiB 读法（19,429,928 B = 18.53 MiB、10,185,576 B = 9.71 MiB）——文件没变，只是单位统一了。
> 产物分别留在 `temp/split/`、`temp/textsize/`（scratch 目录，不进仓库）。

### C. 参考

- [`flash-text.md`](flash-text.md) §1（能力盘点）§2（D-T1…D-T21 差距清单）§5（双端报告口径）
- [`skia.md`](skia.md) §2.9（链接不内嵌）§6.1（Skia 重编）§6.4（版本选型）§6.9（CoreText 补丁）
  §7（多目标）§8（文本的两档方案 + 校准史）
- [`html5-web.md`](html5-web.md) §3.1–§5.2（web 渲染、字体注入、`SK_TRIVIAL_ABI`、`EXPORTED_FUNCTIONS`）
- [`swc.md`](swc.md) §9.2（烘焙时间轴 / 文本字符烘成 `TextField`）
- [`compile.md`](compile.md) §2（预编译依赖四套）§4（构建清单）§5（多目标表）§6.1（target × package）
  §6.4（清单扩展字段）
- [`size-optimization.md`](size-optimization.md)（`static` 化 + `-O2` tree-shake）
- `build-tools/skia-src/out/{macos-arm64,wasm}/args.gn`（unicode/整形开关的现状）
- `vendor/provision/README.md`（Windows MSVC ABI 硬约束）