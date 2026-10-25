# 文本排版后端：先把文本引擎拆出链接（已完成），再决定要不要换 Rust

> **状态：体积部分全部落地——第一步拆分（阶段二百二十一，`v0.4.195 → v0.4.196`）+
> 两刀收尾（阶段二百二十二，`v0.4.196 → v0.4.197`）；只有"换 Rust 引擎"仍是评估，未实施、无版本号。**
>
> 本文回答三个问题，顺序不能颠倒：
>
> 1. **能不能让程序只为它真正用到的部分付链接钱？** ——**能，已做，已实测**：
>    ① 把文本 glue 拆成独立源文件 / 独立对象，构建层按程序是否用到 `flash.text` 决定链不链它
>    （**19.43 MB → 6.53 MB**）；② 链接期 `-Wl,-dead_strip -Wl,-x`（**→ 3.55 MB**，全构建生效）；
>    ③ 把 ICU 数据从桌面整份（10.19 MB）换成 Skia 自己给 wasm 用的那份（0.80 MB）
>    ⇒ **画文字的构建 19.43 MB → 6.05 MB（−69%）**，语义零改动。
> 2. **要不要把排版引擎换成纯 Rust（cosmic-text + swash + harfrust）？** ——**接点现成
>   （15 个函数的不透明接缝），但值得做的场景极窄**：桌面与 web 不值得，唯一算得过账的是
>   移动端 + 体积硬约束，且真正的成本不是链接，是把 `adl` 逐值校准出来的排版口径在一个
>   算法完全不同的引擎上**重做一遍**（§9）。
> 3. **验收口径（2026-10-25 修订）：文字渲染不再逐值对齐 `adl`** ——只要 API 面与自洽性对齐，
>    每个字的宽度、断行落点、行高取整由我们自己的排版引擎决定（§12）。它使 §9 的 B1/B2 降级、
>    §11 多出一条与体积无关的前置分支，也给 markdown 之类的上层能力留出空间。
>
> 两处修订改变了本文的结构：旧稿（2026-10-20）把"拆成独立对象"写成"换引擎的前置条件"，
> 实际上它**本身就是收益**；而阶段二百二十二之后连"文本栈剩下的 13 MB"也不成立了——
> 882 KB 的数据选择 + 两条链接旗标就吃掉了其中 12.4 MB（§3、§10）。
>
> **第三次修订（2026-10-25）**：验收口径从"与 `adl` 逐值相等"改为"API 面对齐、度量自定"（§12）。
> 因此 §9 的 B1/B2 从 🔴 降为 🟠、§11 的决策树多出一条前置分支，并新增 §13（GPUI 的文本栈旁证）。

---

## 0. 范围与两步走

**第一步（已做完，本文 §1–§2）**：把 `vendor/skia_glue.cc` 里的文本段拆成
`vendor/skia_text_glue.cc`，让"不使用文本"的构建**根本不把它放进链接**。这一步不改任何
AS3/渲染语义，只改**链接图**。

**体积收尾（已做完，本文 §3 的 L1/L2a）**：`-Wl,-dead_strip -Wl,-x` 与 0.80 MB 的 ICU 数据包。
同样不碰语义，是把"链进来了但从不执行/从不读取"的部分去掉。

**第二步（评估，本文 §4–§11）**：把 §1.1 那 15 个接缝函数的**实现**从 SkParagraph 换成
Rust 静态库。这一步会改语义，要重做全部排版校准。

**不在范围内**：`TextField` 的 AS3 语义本身（见 [`flash-text.md`](flash-text.md)）；
Skia 的整体集成与 Metal 后端（见 [`skia.md`](skia.md)）；SWC 静态文本烘焙（见 [`swc.md`](swc.md)）。
前端保持 TypeScript（不转 Rust），那是与本议题无关的独立决定，本文不再讨论。

**唯一 oracle**：AIR 51.4.1 的 `adl`。凡本文提到"对得上/对不上"，都以 `adl` 逐值为准
（AGENTS §1.5）。

---

## 1. 现状：文本管线是四层，接缝只有一个

```
① 生成的可读 C        as_tf_*  /  TextField_*        （emit.ts 发射，唯一接触 C 字符串的地方）
        │  调用
② runtime.ts 的 inline 转发层   as_skia_text_measure / as_skia_textlayout_*
        │  runtime.ts:9260+（ASC_USE_SKIA + ASC_HAVE_TEXT）
        │  runtime.ts:9992+（无 Skia 或未链文本引擎：全 0 桩）
③ C 接缝（extern，15 个函数）   src/runtime.ts:9068–9083
        │
④ 胶水实现            vendor/skia_text_glue.cc（695 行，阶段二百二十一拆出）
        │              SkParagraph / SkFontMgr / SkTypeface / HarfBuzz / ICU
⑤ Skia 预编译库        vendor/skia/lib/<platform>/
```

### 1.1 接缝就只有 15 个函数

| 组 | 函数 | 位置 |
|---|---|---|
| 单行测量（2） | `sk_text_measure` / `sk_text_measure_n` | `runtime.ts:9068–9069` |
| 段落排版（13） | `sk_textlayout_new` / `_new_leading` / `_new_runs` / `_height` / `_max_width` / `_line_metrics` / `_line_box` / `_line_count` / `_paint` / `_delete` / `_glyph_position_at` / `_rects_for_range` / `_caret_rect` | `runtime.ts:9070–9083` |

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

`src/runtime.ts:9260` 起的接缝转发层现在是三段：

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

> 表中"用文本的程序不变"是**本阶段**的事实：紧接着的阶段二百二十二用 L1 + L2a 把同一份程序
> 压到 **6.05 MB**（§3.1、§10）。两刀切的是"链进来但不可达/读不到"的部分，与拆分互不替代。

### 2.7 这次拆分的四个坑（都写进注释了）

| 坑 | 症状 | 处理 |
|---|---|---|
| `RUNTIME_PREAMBLE` 是**反引号模板串** | 在 C 注释里写反引号 → TS 直接语法错（`ERR_INVALID_TYPESCRIPT_SYNTAX`） | 注释里不出现反引号 |
| 同上，`\n` 会被 JS 先吃掉 | `fprintf(stderr, "...\n")` 在生成的 C 里变成真换行 + 断串 | 源里写 `\\n` |
| 单元钉子按"单个 glue 文件"读源码 | 5 个组（`display`/`render`/`text-input`/`platform`/`build`）在文本代码搬走后全红 | `test/harness.ts` 加 `readGlue()`（两文件拼接）；**拆分本身**由新组 `unit: build/TextEngineSplit`（13 条）单独钉 |
| 把 `sk_platform_fontmgr` 改成非 `static` 后，`platform/FontFallback` 的锚点串失效 | 断言 `#else\nstatic sk_sp<SkFontMgr> sk_platform_fontmgr()` 找不到 | 锚点同步去掉 `static`，并在组里注明"两半共享"的理由 |

---

## 3. 第二步的账：拆完之后还剩多少（已全部结算）

拆分把"画不画文字"的差**明确化**了：它从"人人有份"变成一笔**可选的 12.90 MB**。
剩下的三项已经在阶段二百二十二全部量完、落地两项、否掉两项，见下表（数字都是同一份产物逐档加料量的）：

| 路线 | 做法 | 实测收益 | 风险 | 状态 |
|---|---|---|---|---|
| **L0** | **拆分**（不用文本 → 不链文本栈） | **−12.90 MB**（对不用文本的构建） | 已消化 | ✅ 已完成（阶段二百二十一） |
| **L1** | 链接期 `-Wl,-dead_strip -Wl,-x` | 不画字 **−2.98 MB**、画字 **−3.92 MB**、Skia app **−5.17 MB** | 低（全量 429 项回归验过 ObjC 类别/typeinfo） | ✅ 已完成（阶段二百二十二） |
| **L2a** | **换 ICU 数据包**：Skia 自己给 wasm 用的 `flutter/icudtl.dat`（0.80 MB） | 画字的构建再 **−9.46 MB** | 低（web 一直用的是同一份；全量回归绿） | ✅ 已完成（阶段二百二十二） |
| **L2b** | Skia 重编：`skia_use_icu=false` + `skia_use_icu4x=true` | 与 L2a 目标重叠（都是 ICU 数据），L2a 已用 0.80 MB 把它拿掉 | 中（需 Rust 工具链 + 重编两端 + 重验排版） | ⏸ **已被 L2a 取代**，仅在需要 ICU4X 的 locale 能力时再看 |
| **L3** | Skia 重编：`skia_use_libgrapheme=true` + `skia_use_icu=false` | 与 L2a 同级，但更激进 | 高（libgrapheme **不做 bidi**） | ⚠️ 否决 |
| **L4** | 裁 `air-app.ts` 里 1:1 列出的 codec（`skottie`/`svg`/`dng_sdk`/`piex`/`expat`） | **0 字节**（实测：删掉这些库产物一模一样） | — | ✅ 已被 L1 完全覆盖，**无需动手** |
| **L5** | **换 Rust 文本引擎**（本文第二步） | 原本值是"用文本的构建再省 ~13 MB"，**那 13 MB 已经不在了**；现在最多再省 ≈2.7 MB | **高**（§9 B1/B2） | ⏸ 只在移动端 + 体积硬约束时 |

**这张表的读法**：① L0 省的是"不用文本的程序"，L1 省的是"所有程序里链进但不可达的部分"，
L2a 省的是"用文本的程序里读不到的数据"——三者互不叠加、也不互相替代，**都已落袋**。
② L5 的卖点在阶段二百二十二之后大幅缩水：一个画文字的构建从 19.43 MB 降到 6.05 MB，
其中 Skia+整形栈只剩 ~4.9 MB，而**换引擎要动的恰恰是这 4.9 MB**——用重新校准全部排版口径的
代价去换 2.7 MB，只在"移动端 + 商店体积硬约束"下才值得（§11）。

### 3.1 L1 与 L2a 是怎么落的（阶段二百二十二）

**L1：`src/build.ts::linkTrimFlags`** —— `-Wl,-dead_strip` 让 ld64 **先丢不可达代码块、再解析块内引用**，于是胶水 `.o` 里提到而程序没调用的 Skia API 不再把 archive 成员拉进来（这也是 §2 那刀能兑现的前提）；`-Wl,-x` 砍的是 `__LINKEDIT` 里的**局部符号表**，全局符号不动。

**刻意不做的三件，都留了数**：`-flto` 全链实测 **3,567,592 B vs 3,554,632 B（反而大 13 KB**，Skia archive 不带 bitcode）；ELF/COFF 的 `--gc-sections` 需要编译期 `-ffunction-sections -fdata-sections`（含每个预编译 archive）才有效，现在发出去只会得到"看起来在工作、其实零收益"的旗标，故整族不发；`--debug-info` 时不发 `-x`（那个构建就是要符号），`-dead_strip` 仍发。

**L2a：`src/build.ts::icuDataPaths`** —— 数据源是 `vendor/skia/icu/icudtl_flutter.dat`（0.80 MB，与 Skia 自己给 wasm 用的是同一份），构建期汇编成 `.s` 再编成 `.o`（~0.2 s：3.4 MB 汇编文本 45 ms，汇编 155 ms），**作为普通对象塞在 `-l` 之前**。

为什么这样就够：**archive 成员只在"它的符号还没定义"时才被拉取**。我们的对象先定义了 `_icudt69_dat`，`libskunicode.a` 里那个 10.19 MB 的成员就**根本不会被读**——不需要动 vendor 里的任何二进制，也就不存在"换掉 `.a` 之后被别人重新 provision 覆盖"的问题。

三个坑（都写进注释了）：

1. **`icudtl_dat.o` 有两份**：`libskunicode.a` 与 `libicu.a` 各一份，真正被链接的是 **skunicode 那份**（`-l skunicode` 在 `-l icu` 前面）。只换 `libicu.a` 时二进制**一个字节都没变**，且没有任何报错。——这条陷阱在落地方案下**已经不存在**（我们定义符号、不是换 `.a`），但它留下了两条静默面，见 §3.2。
2. **Xcode 工程那条路要单独接**：那个 `.s` 必须作为**源文件**进 target（文件类型 `sourcecode.asm`），否则走 Xcode 构建的 App 又会付回 10.19 MB。
3. **`--dry` 不能写文件**：汇编源由 runner（`index.ts`）在跑步骤前物化，命令组装阶段（`buildCompileSteps`）一个字节都不写，所以预演天然干净——不是靠 `if (dry)` 分支堵出来的。

### 3.2 把两处静默面收口（阶段二百二十三）

§3.1 的两个杠杆各自留下一处**静默**：对象路径共享、ICU 判据挂错了条件。两处都不改任何语义，但都能让体积悄悄涨回去、或让构建悄悄链错东西，故都收口。

**一、对象文件按「配置」分目录（`src/build.ts::objectDir`）**

对象文件是**整份**参与链接的（§2.1），内容是**编译它的那组旗标**的函数——所以「一个源文件一个路径」只在所有构建都同意那组旗标时才成立，而它们不同意：示例套件里 `examples/swc-bitmap.build.json` 编 `vendor/window_glue.cc` 时不带 GPU 后端，away3d / air-native 那几张清单带 `ASC_RENDER_METAL`，而它们**并发**跑（`test/examples.ts`，jobs = min(核数, 6)），两条都写 `vendor/window_glue.o`。实测同一源文件两组宏的对象大小：**29,216 B vs 30,896 B**（`skia_glue.cc` 是 33,416 vs 38,200），⇒ 谁后编完谁说了算：另一条要么拿到自己没申请的通道，要么（手工重链残留对象时）以 `Undefined symbols: _sk_window_show_gpu` 收场。

修法：对象落在 `$TMPDIR/as-aot-obj/<配置指纹>-<构建进程 pid>/<源路径指纹>-<基名><后缀>.o`，指纹覆盖编译器、target、`-O`、perf/fp/debug 旗标、defines、include 路径（**不排序**——`-I` 顺序决定哪个头文件赢）。**不做缓存**：每个源仍然每次重编，只是不再互相回答。阶段八十九·三十二 的 `.wasm.o` 后缀保留，作为可读的第二道闸。目录名里为什么还要 pid、以及成功后整个目录为什么被删掉，见下面的「三」。

**二、ICU 判据从「链了 `-l icu`」改成「文本引擎进链接了」+ 版本金丝雀**

原来的守卫是 `linkLibs.includes('icu')`，看着等价其实不是：清单里只要漏了 `icu`，那个数据成员仍由 `libskunicode.a` 自己带上，于是替换被跳过、10.19 MB 又跟了进来。实测 `examples/tf-scale-metrics.as` 去掉 `-l icu`：**15,510,408 B（15.51 MB）而非 6,049,032 B（6.05 MB）**，退出码 0、一个字都不说。现在判据只看 `ASC_HAVE_TEXT`（文本引擎是唯一消费者；对象没人引用时 `-dead_strip` 会丢掉，所以放宽是安全方向）。

再加一条**金丝雀**：`nm -g libskunicode.a` 读出它期望的 `_icudtNN_dat`，与 `.dat` 标记比对，不一致就**报一行**（「两套数据都会链进来，+9.46 MB，仅体积」）。符号带版本号 ⇒ 不一致不可能产生错数据、只会让体积悄悄回去——**正因为唯一的症状是体积，才必须报出来**。

**三、共享写路径本身就是竞态（对象必须按构建进程私有）**

这是「一」只按配置分目录**没堵住**的那半，而且它不是推理出来的，是把红了的套件跑出来的：`node test.ts` 三轮里红两轮，失败的单元是 `textfield/ (Main.as, UiMain.as, entry.as)`，报错一行：

```
ld: file is empty in '.../vendor/skia/icu/icudtl_flutter.o'
clang++: error: linker command failed with exit code 1
```

机理：ICU 数据对象当时**故意共享**（「字节对每个构建都一样，共享才能只汇编一次」），但那条汇编步骤**每次文本构建都跑**，而 `clang -c` 是**先开（截断）输出文件、编译完再写**——于是那 800 KB 的 `.o` 在整整 ~150 ms 里是**空文件**，此刻另一条构建正在链接它。教训写进注释了：**内容相同不等于共享安全**，非原子覆盖只有「路径私有」能救。

修法（三条一起）：① `objectDir` 带 `-<pid>`，两个构建**连名字都撞不上**；② ICU 的 `.s`/`.o` 也进这个目录（`icuDataPaths`），源树里只剩被跟踪的 `.dat`，`.gitignore` 里那条 `vendor/skia/icu/*.s` 随之删除；③ 链接成功后 `cleanObjectScratch` 把整个目录删掉（文本构建约 3 MB），**失败则刻意保留**——那是事后分析要的现场，这也正是回收点写在 `index.ts` 而不是 `finally` 的原因。顺带把「组装命令行会写盘」这个副作用也挪走了：建目录改在 `runCompile`（`ensureOutDir`），所以 `buildCompileSteps` 变成纯函数。

实测（`temp/pitfall/stress-shared-obj.sh`，120 次并发文本构建共用一个配置）：

| 版本 | 失败 | 症状 |
|---|---|---|
| 修复前（共享路径、无回收） | **9 / 120** | `ld: file is empty in .../icudtl_flutter.o` |
| 修复后（按 pid 私有 + 成功后回收） | **0 / 120** | — |

`--dry` 的行为不变（打印对象路径、不创建任何东西），但现在是**结构上**成立：组装阶段不碰文件系统。Xcode 那条路另说一句——`.s` 改成写进**生成出来的工程目录**（自包含，Xcode 在本进程退出后很久才编它），源树保持只有输入。

| 场景 | 收口前 | 收口后 |
|---|---|---|
| 文本构建，清单漏 `-l icu` | 15,510,408 B，静默 | **6,049,032 B** |
| 两条不同宏的构建并发 | 共享 `vendor/*.o`，可串 | 各自独立目录，互不可见 |
| vendor 树升到别的 ICU 大版本 | 静默 +9.46 MB | stderr 一行报明 |

---

## 4. 候选技术栈（Rust 侧）

| crate | 职责 | 对应现在是谁 | 备注 |
|---|---|---|---|
| `harfrust`（原 `rustybuzz`） | **整形（shaping）** | HarfBuzz | rustybuzz 的下一代；**`cosmic-text 0.19` 已经用它**（`Cargo.lock` 实证，见 §13.1）。语义仍与 HarfBuzz 同源、迁移风险低，但"去掉 HarfBuzz"实际上是"换成 HarfBuzz 的 Rust 版" |
| `ttf-parser` | 字体解析 / cmap / 度量 | FreeType + SkTypeface | |
| `swash` | **光栅化 + 字形缓存** | SkScalerContext + SkGlyphCache | `0.2.x` 内核已换成 `skrifa`/`zeno`/`yazi`（§13.1）；彩色 emoji（CBDT/sbix）支持偏弱 |
| `fontdb` | 字体枚举 / 家族匹配 | `SkFontMgr` | 三端平台字体管理器已覆盖，见 §1.3 |
| `cosmic-text` | **断行 + 段落 + 缓存** | SkParagraph（UAX#14） | 依赖以上全部 |
| `parley`（备选） | 断行 + 段落 | SkParagraph | 与 `swash` 同属 linebender，更活跃 |

**关键取舍**：整形用 `harfrust`（`rustybuzz` 的后继）意味着"语义同源"（对 AIR 对齐有利），但**省不掉整形逻辑本身**；
而"去掉 ICU 的数据表"这件事**已经不需要换引擎了**（L2a 已把 10.19 MB 换成 0.80 MB）——所以换 Rust
真正能省的只剩 **HarfBuzz + SkParagraph 那份 C++ 实现，约 2.7 MB**（§3 表 L5 行）。

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
| P0 | ~~§3 的低风险项~~：**L0 + L1 + L2a 全部已完成**（阶段二百二十一 / 二百二十二）；`icu4x`（L2b）已被 L2a 取代 | 体积 + 全量回归 |
| P1 | 桌面 **A/B 双后端**（档 3）：同一份 `textfield` 示例跑两遍，用 `adl` 双端报告 diff 出**差异清单** | `flash-text.md` §5.1 数值报告 |
| P2 | 按差异清单逐项校准；差异收敛后切默认 | 差异清单归零（或如实登记） |
| P3 | 移动端 target 落地时，只在该 target 打开 Rust 后端 | 按 target 分层（`compile.md` §4.1） |

---

## 7. 逐端分析

### 7.0 总表

| 端 | 状态 | 现在谁在做文本 | 换 Rust 的**收益** | 换 Rust 的**代价/风险** | 结论 |
|---|---|---|---|---|---|
| **macOS native** | ✅ 已上线 | CoreText（字体）+ SkParagraph（排版）+ 本仓 CoreText 补丁 | 体积 ~4.9 MB（L2a 之后；曾 ~13 MB） | 丢掉 `skia.md` §6.9 的补丁收益、emoji（Apple Color Emoji）、全部 adl 校准 | ❌ 不做 |
| **Windows native** | ✅ 已上线 | GDI + DirectWrite 双回退 + Uniscribe 整形 | 体积 ~4.9 MB + 10.19 MB ICU 数据（Windows 尚未 port L2a，见 §10） | 要自建 DirectWrite 等价回退链；emoji（Segoe UI Emoji） | ❌ 不做 |
| **Linux native** | ⛔ 未 provision | —（`vendor/skia/lib/` 无 linux） | — | — | ⛔ 无对象 |
| **web (emcc)** | ✅ 已上线 | `SkFontMgr_New_Custom_Data` + 运行时注入 `font-urls` | 体积（wasm 文本栈归档 22.1 MB；`.wasm` 首屏体积可省 ~7 MB 量级） | 字体注入契约要重做；但**首屏体积收益相对量级最大** | ⚠️ **最有价值的一档** |
| **WASI (raw)** | ✅ 已上线（无 GUI） | **无**（`as_skia_*` 全 0 桩，`runtime.ts:9992+`） | 0 | 0 | ⛔ 不涉及 |
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
- **体积**：L2a 之后文本栈只剩 **~4.9 MB**（其中 ICU 数据 0.80 MB、Skia+整形 ~4.2 MB）；L2a 之前是 ~13 MB。
- **结论**：❌ **不做**。收益是纯体积，代价是已经钉住的全部行为——而收益已经从 13 MB 缩到 4.9 MB。

### 7.2 Windows native

- **现在**：`SkAirFontMgr(GDI, DirectWrite)` 双层回退（`skia_glue.cc:231`），
  GDI 后端用 Uniscribe 整形（`air-app.ts:676` 注释）。Skia 库有 x64/x86 两套。
- **换 Rust 后**：要自建等价回退链（`fontdb` 读 `C:\Windows\Fonts` 可行，但 DirectWrite 的
  script-aware fallback 要自己写）；emoji 走 Segoe UI Emoji。
- **体积**：~4.9 MB + 10.19 MB ICU 数据（41.4 MB 归档里被拉进来的部分；ICU 那 10.19 MB 在 Windows 上是 port L2a 就能拿掉的，见 §10）。
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
  `as_skia_text_*` 都是**返回 0/NULL 的 inline 桩**（`runtime.ts:9992+`）。
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
| A1 | ~~砍掉 ICU 数据块~~ | **已不需要换引擎**：L2a 已把 10.19 MB 换成 0.80 MB（阶段二百二十二），要拿下这 9.4 MB 不必动排版 | 全端 |
| A2 | **砍掉 skunicode + harfbuzz + skshaper + paragraph** | 合计 ≈2.7 MB（拆分实测：省下的 12.90 − ICU 数据 10.19；L2a 只动数据、不动这段代码）——**这是 L5 现在唯一还站得住的收益**（Skia 的画布/光栅化仍在，换引擎拿不走） | 全端 |
| A3 | **纯 Rust 无 C++ 依赖** | 消除 `SK_TRIVIAL_ABI` / `-std=c++17` / MSVC ABI 互链等约束（`html5-web.md` §5.1、`provision/README.md`） | 全端 |
| A4 | **静态库形态适配移动端** | iOS 无 `dlopen`，静态链是唯一形态 | iOS / Android |
| A5 | **整形语义同源** | `harfrust`/`rustybuzz` 都是 HarfBuzz 的 Rust 移植（`cosmic-text 0.19` 用前者，§13.1）⇒ 迁移风险低于换一门新整形器 | 全端 |
| A6 | **单一引擎跨全端** | 现在 macOS/Windows/web 是**三套**字体管理器 + 两条整形路径 | 全端 |
| A7 | **`cargo` 可复现构建** | 对比 `build-tools/skia-src` 的 gn+ninja 重编（`skia.md` §6.1） | 全端 |
| A8 | **链接图已经就位** | 阶段二百二十一把文本段独立成 `vendor/skia_text_glue.cc`：换引擎 = 换这一个翻译单元，图形半边不受影响 | 全端（本次拆分的副产品） |

## 9. 劣势与代价清单（逐条）

| # | 代价 | 具体是什么 | 严重度 |
|---|---|---|---|
| B1 | **`adl` 校准全部重做** | `flash-text.md` §2 的 D-T1…D-T21 + `skia.md` §8 那一整段：断行阈值恒 `ceil(ink+4)`、`autoSize` 只 `wordWrap=false` 才改宽、`textWidth` 尾空格口径、字段被缩放时 `textWidth/Height` 的 `sy/sx` 口径、字形只按累积 `scaleY` 缩放……这些**全部钉在 SkParagraph 的行为上** | 🟠 **最贵**（2026-10-25 降级，见 §12） |
| B2 | **行盒模型要重推** | `sk_air_line_metrics` + `sk_round_half` + `sk_set_air_strut`（`skia_text_glue.cc:123–168`）——AIR 是 `rhalf(ascent)+rhalf(descent)+leading(px)`、**永不加 line gap**；Skia 是 `ceil(ascent+descent+lineGap)`。这套换算对九个具名字体逐值命中，换引擎后要从零重推 | 🟠（见 §12） |
| B3 | **字体别名语义** | `sk_family_alias`（`skia_text_glue.cc:225`）：`_sans→Helvetica`、`_serif→Times New Roman`、`_typewriter→Monaco`、`NULL→Times`，以及"**未安装的字族回落到平台默认脸**"（`D-T17`，实测差 6 px） | 🟠 |
| B4 | **彩色 emoji** | `swash` 在 CBDT/sbix 位图彩色字体上偏弱；而 CoreText（macOS）、DirectWrite（Windows）都现成支持 | 🟠 |
| B5 | **可装上的字体 ≠ 可枚举的字体** | web 侧的注入契约要重做（§7.4）；native 侧要重建平台回退链 | 🟠 |
| B6 | **丢字形缓存/性能** | 现在 `SkGlyphCache` + Skia 的 glyph atlas 是免费的；Rust 侧要自建（`swash` 有 `scale::Scaler`，但缓存要自己管） | 🟡 |
| B7 | **`skia.md` §6.9 的补丁收益消失** | 那条补丁修的换脸问题在 Rust 侧换一种形式重现（要自己处理"同族同 PS 名"） | 🟡 |
| B8 | **工具链进 CI** | 当前**本机没有 Rust 工具链**（`rustc`/`cargo`/`rustup` 均 `command not found`）；CI 要加 5~6 个 target 的交叉编译 | 🟡 |
| B9 | **许可证核对** | Skia=BSD-3、ICU=Unicode License；Rust 侧 `cosmic-text`/`swash`/`fontdb`/`harfrust`/`skrifa`/`ttf-parser` 的许可证需逐项核对后再定（**本文未核对**，落地前必查） | 🟡 |
| B10 | **双后端期体积最大** | 档 3（A/B 并行）时期，两份字体栈同时在二进制里 | 🟡 |
| B11 | **全套回归要重跑** | 200+ 示例 + `textfield` 双端报告 + `[textwrap]` 等结构钉 | 🟡 |

> **2026-10-25 修订**：B1/B2 已从 🔴 降为 🟠——验收口径改为"API 面对齐、度量自定"（§12）。
> 它们不再是换引擎的阻断项，只在"仍想与 `adl` 逐值对拍"时才需要重做；`flash-text.md` 的
> D-T 系列随之从**语义契约**降级为**当前实现的基线快照**。

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

## 10. 终态：三种构建的完整账

三刀都已落地（L0 阶段二百二十一；L1/L2a 阶段二百二十二），下表是**同一批程序**逐档加料的实际字节数：

| 构建 | 初始 | +L0 拆分 | +L1 | +L2a |
|---|---|---|---|---|
| 不画文字（`draw-over`） | 19.43 MB | 6.53 MB | **3.55 MB** | 3.55 MB（无 ICU，不变） |
| 画文字（`tf-scale-metrics`） | 19.43 MB | 19.43 MB | 15.51 MB | **6.05 MB** |
| `--air-app air-native`（Metal+SDL+curl+文本） | 23.97 MB | — | 18.80 MB | **9.34 MB** |

画文字的构建 19.43 → 6.05 MB（**−69%**），Skia app 23.97 → 9.34 MB（**−61%**），不画文字的 19.43 → 3.55 MB（**−82%**）。
画文字构建剩下的 6.05 MB 里，ICU 数据 0.80 MB、Skia+整形栈约 4.2 MB、我们自己的运行时与 C 约 1.0 MB。

**两项明知的缺口（如实报明，未做）**：

| 平台 | 状态 |
|---|---|
| **Windows** | `icudtl_dat.obj` 在 `skunicode.lib` 里且是 COFF，需在 Windows 上重编数据对象；本机无法验证 ⇒ **Windows 仍付 10.19 MB** |
| **Linux** | 没有 Skia 预编译树；且 `--gc-sections` 需先给编译期加 `-ffunction-sections -fdata-sections`（含预编译 archive），属独立工程 ⇒ **未做也未发旗标** |

`build-tools/skia-src/out/{macos-arm64,wasm}/args.gn` 现状（两个文件一致，`skia_use_icu` 保持 `true`——
L2a 换的是**数据包**，不是 ICU 实现）：

```
skia_use_icu = true
skia_use_icu4x = false          ← 只有真要 ICU4X 的 locale 能力时才需要
skia_use_libgrapheme = false
skia_use_harfbuzz = true
skia_enable_skparagraph = true
skia_enable_skshaper = true
```

---

## 11. 触发条件与决策树

**前置分支（2026-10-25 增补）**：

```
需要 flash.text 给不了的排版能力（markdown / 富文本 / 自定义换行）？
├─ 是 ──► 先做**上层**（run 扩展 + 解析器），不换引擎：见 §12.4
└─ 否 ──► 才进入下面的体积判断
```

```
体积是硬约束？
├─ 否 ──────────────────────────► 不做 L5。L0/L1/L2a 已经自动生效，什么都不用做。
└─ 是
   ├─ 该构建画文字吗？
   │  ├─ 否 ──► 已经自动解决（阶段二百二十一），不需要任何人做决定。◄── 已落袋
   │  └─ 是
   │     ├─ 该端是 macOS？
   │     │  ├─ 是 ──► 已经自动解决（L1+L2a，阶段二百二十二）。6.05 MB，通常已经够了。◄── 已落袋
   │     │  └─ 否 ──► 先把本阶段的两刀 port 过去（§10 缺口表：Windows 的 COFF 数据对象、
   │     │             Linux 的 provision + 编译期分节），别急着换引擎
   │     └─ port 完之后仍不达标？
   │        └─ 是 ──► 才轮到 L5（Rust 文本引擎），且**只在该 target 打开**
   │                   （targets.<target> 分层，替换语义）；预期收益约 2.7 MB，不是 13 MB
```

**具体触发**（四条同时成立才启动 L5）：

1. `--target ios` 或 `--target android` **已落地**（现在是"规划"，`compile.md` §6.1）；
2. 该端的**体积被外部硬约束**（应用商店 / 首屏预算）；
3. L0/L1/L2a 在该 target 上**已生效**（含把 ICU 数据换成 0.80 MB 那份）；
4. 仍然超标，并留下实测数据。

> **另有第二类触发（与体积无关）**：若将来要做"跨端完全一致的文字度量"（服务端排版校验、
> 三端截图比对流水线），则"每端委派给系统文本 API"本身成为障碍（§13.1 结论一），cosmic-text
> 才获得第二个理由。它与体积触发互不替代，也不改变本文"桌面不做"的结论。

---

## 12. 验收口径：API 面对齐，度量自定（2026-10-25 决定）

> 这一节重算了本文 §9 的代价与 §11 的决策树。口径变更只有一句：**文字渲染不再要求逐值对齐
> `adl`**，只要求 `flash.text` 的 **API 面**（形状、行为、错误、自洽性）对齐；每个字的 advance、
> 断行落点、`ascent`/`descent` 如何取整，由我们自己的排版引擎决定。理由是 AIR 的文本呈现
> 已经严重落后（没有 markdown、没有 CSS 布局），把它当像素 oracle 会让我们永久继承一个过时的
> 排版模型——**AIR 落后在 API 面，不落后在排版内核**（§12.4）。

### 12.1 三类东西，归属不同

| 类别 | 内容 | 归谁 | 怎么验 |
|---|---|---|---|
| **A. API 面（逐字对齐 AIR）** | 类/方法/属性的形状与默认值；常量值（`GraphicsPathCommand`、`TextFormatAlign`…）；参数非法时的错误号与文案（`#2008`/`#2004`/`#2007`…）；状态机触发关系（`autoSize` 只在 `wordWrap=false` 时改宽、`htmlText` 往返、`appendText` 与光标）；`scrollV`/`maxScrollV` 的钳制；`text` 与 `htmlText` 的规范化 | AIR（`adl`） | 精确断言：`test/unit/` 钉文案与常量，示例钉行为 |
| **B. 自洽性（必须成立，数值我们定）** | `numLines == getLineMetrics().length`；`Σ getLineMetrics(i).height == textHeight`；`getCharBoundaries(i)` 落在 `[0, textWidth]`；`getLineIndexAtPoint` 与行盒互逆；光标矩形落在行盒内；选区矩形按行单调；`textWidth` 等于最长行宽 | 我们 | 结构性断言：只钉关系，不抄像素 |
| **C. 绝对度量（我们定）** | 每个字形的 advance；断行落点（因此 `numLines` 可能与 AIR 不同）；行高是否含字体自身 line gap；ink 包围盒 vs 排版盒；亚像素定位与 AA 强度 | 我们 | 只进**报表**（§12.2 的 Tier 2） |

一句话：**形状照 AIR，数字照我们**，且数字必须自洽。

### 12.2 两层验收（Tier 2 必须落盘，否则就是静默差异）

| 层 | 内容 | 拦 CI 吗 |
|---|---|---|
| **Tier 1（gate）** | A 类全部 + B 类全部 | 是 |
| **Tier 2（report）** | 同一批探针在 `adl` 与我们的产物上的 C 类差异：行数、`textWidth`/`textHeight`、逐行 `ascent`/`descent`、`getCharBoundaries` 首末点 | 否，但**每次改排版就出一张表**进 `docs/`（`flash-text.md` §5 的双端报告格式可直接复用） |

为什么 Tier 2 不能省：C 类差异在程序里是**可见结构**（`if (tf.numLines > 3)` 是真实写法），
不是"长得不一样"。不落盘就等于让读者从"AIR 对齐"的旧叙述里读出错误预期，违反 AGENTS §1.5
（如实报明差异，不静默）。

### 12.3 随之降级的东西

- §9 的 **B1**（D-T1…D-T21 全部重做）与 **B2**（行盒换算重推）从 🔴 降为 🟠：它们仍然是
  "想和 `adl` 逐值对拍时"的成本，不再是把换引擎钉死的理由。
- `flash-text.md` §2 的 D-T 系列从**语义契约**降级为**当前实现的基线快照**：它记录的是现在这套
  SkParagraph 口径，换引擎后要能**解释**差异，而不是必须**复现**。
- **没降级**的是 A/B 两类：它们不依赖任何字体，仍可精确断言。

### 12.4 这条政策**不**构成换引擎的理由

一个常见推论是"AIR 落后（没有 markdown）⇒ 该换排版引擎"。这一步不成立，因为 **markdown 是上层，
不是内核**：

```c
// src/runtime.ts:8831 —— 富文本 run 已经支持逐段样式
typedef struct { unsigned start; unsigned end; const char* family; double size;
                 int bold; int italic; unsigned color; double leading; } sk_text_run;
```

`sk_textlayout_new_runs` 把这些 run 交给 `ParagraphBuilder`，所以 markdown 的粗体/斜体/行内代码
（换 `family`/`size`）/标题/颜色**全部落在现有 13 个函数的能力内**；缺的只是 run 上的
`underline`、`strikethrough`、`background`、`link` 几个字段（我们自己控制的 C 结构体，加字段即可）
与一个 markdown → run 的解析器。

也就是说：受限的是**我们自己的封装没往上长**，不是 SkParagraph 的能力。它背后是 HarfBuzz + ICU，
整形能力本身不弱于任何候选 Rust 栈。

于是换引擎仍然只为两件事：**体积**（约 2.7 MB，§3 表 L5 行）与**去掉 C++/ICU 依赖**；代价则从
"重做校准"变成"断行/光标/选区/命中四类自研"（若走 §13.2 的字形级接缝）。**用自研换 2.7 MB，
谈判条件没变。**

> 若 markdown 之类的能力真要落地，按 AGENTS §1.5 应作为 `asaot.ui.*` 的新能力或 opt-in 开关，
> **不得改写 `flash.text` 已定义的行为**。

---

## 13. 旁证：GPUI（Zed）的文本栈——每端一个后端

> 调研对象：本工作区的 `asaotui/gpui-src/`（Zed `5447804`，2026-10-21，`gpui 0.2.2`）。
> 用在这里的目的只有一个：看一个**生产级、但不背 AIR 对齐义务**的框架如何切文本栈。
> 本节全部是**源码与 `Cargo.lock` 的代码事实**——没有在本机构建或运行 Zed，所以"它选了谁"
> 是可验证的，"它排得好不好看"不在本节主张范围内。

### 13.1 它没有"一个"引擎

接缝是 `pub trait PlatformTextSystem`（`crates/gpui/src/platform.rs:1503`），返回
`LineLayout { width, ascent, descent, runs: [ShapedRun{font_id, glyphs:[ShapedGlyph{id, position,
index, is_emoji}]}] }`（`crates/gpui/src/text_system/line_layout.rs:19`）。实现在六个平台 crate 里：

| 端 | 整形 | 字体 | 光栅 |
|---|---|---|---|
| macOS / iOS（`gpui_apple/src/text_system.rs`） | **CoreText** `CTLine::new_with_attributed_string`（`:583`） | `font-kit` + CTFontCollection | **CoreGraphics** bitmap context + `CTFont::draw_glyphs`（`:444`），灰度；emoji 走 RGBA |
| Windows（`gpui_windows/src/direct_write.rs`） | **DirectWrite** `CreateTextFormat` → `CreateTextLayout` → `IDWriteTextRenderer::Draw`（`:524`–`:645`） | DirectWrite collection（含内存字体 loader） | `IDWriteGlyphRunAnalysis` → ClearType 3×1 / aliased 纹理；COLR/PNG/JPEG/SVG 彩色字形另取图像 |
| Linux（`gpui_linux/src/linux/text_system.rs`，**全文一行**） | **cosmic-text** | fontdb | **swash** |
| web / wasm（`gpui_web/src/text_system.rs`） | cosmic-text（外叠一层 Canvas2D 回退测量） | 注入字节进 fontdb | swash |

`cosmic-text 0.19.0` 的真实依赖（`Cargo.lock`）：整形 **`harfrust 0.5`**（rustybuzz 的下一代；
`rustybuzz 0.20` 在该 lock 里只被 `usvg` 拉）、光栅 **`swash 0.2.6`**（内核已换成
`skrifa` + `zeno` + `yazi`）、度量/轮廓 `skrifa 0.40`/`read-fonts`、枚举 `fontdb 0.23`
（`ttf-parser 0.25`）、断行/分段 `unicode-bidi`/`unicode-linebreak`/`unicode-script`/
`unicode-segmentation`。`font-kit` 在 cosmic 臂里只用于"最优匹配"（`cosmic_text_system.rs:1177`）。

**结论一**：GPUI 只在"没有权威系统文本 API"的两条臂（Linux、浏览器）上用 Rust 栈；桌面两臂与我们
同为"委派给 OS"。这是 §7.0 那两条"❌ 不做"的同构旁证。

**结论二**（对我们更要紧）：GPUI **不把断行外包**——UAX#14 换行在框架侧
（`crates/gpui/src/text_system/line_wrapper.rs`），后端只整形**一行**
（`ShapeLine::new(…, Shaping::Advanced)` + `Wrap::None`，`cosmic_text_system.rs:748`）。
这与我们"把断行一起外包给 SkParagraph"正好相反，也是 §13.2 那笔自研成本的来源。

### 13.2 能借的、不能借的

| | 内容 | 判断 |
|---|---|---|
| 可借 | **字形级接缝**：后端只出 glyph id + 位置，光栅是独立函数、结果进 atlas（`metal_atlas`/`directx_atlas`/`wgpu_atlas`） | 让"双后端 A/B"（§5 档 3）变成"共用同一份 `LineLayout`、只换 rasterizer"。代价是断行/行盒/光标/选区四类自研——也就是我们现在**白拿**的那部分 |
| 可借 | **每端一个后端** | 我们在字体匹配上已经这么做（§1.3）。但把**整形**也按端委派，等于"一处校准、全端一致"变成"三处校准"，与 §12.2 的 Tier 2 报表口径冲突 ⇒ **不采纳** |
| 不能借 | "省掉校准" | GPUI 没有 `adl` 这样的 oracle：`ascent`/`descent` 直接吃平台给的数（Windows 取 `DWRITE_LINE_METRICS.baseline` 与 `height - baseline`，`:583`–`:591`），不存在 B2 那套 `rhalf(ascent)+rhalf(descent)+leading` 的换算。它的成本单里**没有 B1/B2**，所以"GPUI 在用 cosmic-text"不能给我们的迁移风险打折 |
| 参考 | 平台细节要复刻的量级 | macOS 臂固定 `TextRenderingMode::Grayscale`，并按前景亮度做字体膨胀 `glyph_dilation_for_color`（`:224`，注释明说是"复刻 CoreGraphics 按亮度加粗"）；Windows 看系统设置决定 ClearType/灰度；cosmic 恒 Subpixel。这类细节正是 B1 的实例 |

---

## 14. 附录

### A. 15 个接缝函数（现状全清单）

接缝声明：`src/runtime.ts:9068–9083`；实现：`vendor/skia_text_glue.cc`（`ASC_HAVE_TEXT` 才进链接）。

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

> 另有 **`sk_text_run` 结构体**（`runtime.ts:8831`）**无条件定义**（纯 C 构建也要用）；
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

**B.1b 链接期两刀 + 小 ICU 数据（2026-10-21，macOS arm64，`temp/icuprobe/`）**

| 构建 | 基线 | `-dead_strip` | `+ -x` | `+ 0.80 MB ICU 数据` |
|---|---|---|---|---|
| 不画字 `draw-over` | 6,531,688 | 4,345,176 | **3,554,632** | 3,554,632（无 ICU） |
| 画字 `tf-scale-metrics` | 19,430,208 | 16,685,384 | 15,510,408 | **6,049,032** |
| `--air-app air-native` | 23,968,296 | 20,772,344 | 18,797,064 | **9,335,688** |

| 额外对照 | 结果 |
|---|---|
| LTO（`-flto` 全链） | 3,567,592 —— 比不带 LTO 的 **大 13 KB**，故不做 |
| L4：链接行删掉 `skottie/sksg/svg/skresources/dng_sdk/piex/expat/bentleyottmann` | 3,554,632 —— **完全一样的字节**，故 L4 无需动手 |
| 只换 `libicu.a` 的数据对象（不动 `libskunicode.a`） | 15,510,408 —— **一字节没变**（踩坑记录：真正被链接的是 skunicode 那份） |
| 全量回归（换小 ICU 数据 + L1 两刀） | `node test.ts` **429 / 429 通过**、0 红、0 跳过 |

**B.1c 两处静默面收口（2026-10-21，macOS arm64，`temp/pitfall/`）**

| 项 | 值 | 说明 |
|---|---|---|
| 同一源文件、两组宏的对象大小 | `window_glue.cc` **29,216 vs 30,896 B**；`skia_glue.cc` **33,416 vs 38,200 B** | 证明「共享路径」真的会串 |
| 文本构建 + 清单漏 `-l icu`（收口前） | 15,510,408 B，退出码 0，无输出 | `libskunicode.a` 自带数据成员 |
| 同上（收口后） | **6,049,032 B** | 判据改为 `ASC_HAVE_TEXT` |
| 文本 / 非文本两条构建**并发**跑 | **6,049,032 / 3,554,632 B**，都真跑通过 | 各自配置目录，已不可串 |
| web 侧（`--package web`，emcc） | `hello-web` 5,868,096 B / `air-native` 7,428,052 B，对象落 wasm 配置目录 | `EMSDK_HOME=../build-tools/emsdk` |
| 全量回归（收口后） | `node test.ts` **430 / 430 通过**、0 红、0 跳过 | 新增 `unit: build/ObjectPaths`（14 条） |

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