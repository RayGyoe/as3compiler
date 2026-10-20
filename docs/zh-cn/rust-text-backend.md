# Rust 文本后端：把 `TextField` 排版从 SkParagraph 换成 cosmic-text + swash

> **状态：调研 / 评估文档，未实施，无版本号。**
> 本文回答一个问题：**能不能、值不值得**把 `flash.text` 的排版引擎（现在 = Skia 的
> SkParagraph + HarfBuzz + ICU）换成纯 Rust 技术栈（cosmic-text + swash + rustybuzz），
> 以静态库形式接进来。
>
> **一句话结论**：
> **能接，而且接点早就现成**——文本引擎在 C 侧只是一组 15 个函数的不透明接口
> （`src/runtime.ts:8723–8745`），生成的 C 完全不知道背后是谁。换引擎 = 换一个 `.a`。
> **但值得接的场景极窄**：桌面与 web **不**值得（平台字体管理器已覆盖，SkParagraph 已用
> `adl` 逐值校准），唯一算得过账的目标是**把 Skia 的 unicode/整形栈（实测 ~13 MB，其中
> ICU 数据块单个对象就有 9.71 MB）从链接里彻底拿掉**，而这只有在**移动端 target 开工
> 且体积是硬约束**时才成立。真正的门槛不是链接，是 `skia.md` §8 / `flash-text.md` §2 那批
> 用 `adl` 逐值校准出来的排版口径，要在一个算法完全不同的引擎上**重做一遍**。
>
> **⚠️ 本文第 2 章的实测纠正了一个直觉**：ICU 体积**不是文本路径引入的**——一个完全不画
> 文字的图形应用，二进制**一样大**（18.53 MB == 18.53 MB）。详见 §2.4。

---

## 0. 范围

**在范围内**：`flash.text` 的**排版/度量/绘制**后端选型；Rust 静态库的接入形态；逐端影响。

**不在范围内**：`TextField` 的 AS3 语义本身（见 [`flash-text.md`](flash-text.md)）；
Skia 的整体集成与 Metal 后端（见 [`skia.md`](skia.md)）；SWC 静态文本烘焙（见 [`swc.md`](swc.md)）；
"前端 TS 要不要转 Rust"（那是另一个问题，结论见 §10）。

**唯一 oracle**：AIR 51.4.1 的 `adl`。凡本文提到"对得上/对不上"，都以 `adl` 逐值为准
（AGENTS §1.5）。

---

## 1. 现状：文本管线是四层，接缝只有一个

```
① 生成的可读 C        as_tf_*  /  TextField_*        （emit.ts 发射，唯一接触 C 字符串的地方）
        │  调用
② runtime.ts 的 inline 转发层   as_skia_text_measure / as_skia_textlayout_*
        │  runtime.ts:8886+（ASC_USE_SKIA）  或   runtime.ts:9547+（纯 C 全 0 桩）
③ C 接缝（extern，15 个函数）   src/runtime.ts:8723–8745
        │
④ 胶水实现            vendor/skia_glue.cc:1364–1960（约 600 行）
        │              SkParagraph / SkFontMgr / SkTypeface / HarfBuzz / ICU
⑤ Skia 预编译库        vendor/skia/lib/<platform>/
```

### 1.1 接缝就只有 15 个函数

| 组 | 函数 | 位置 |
|---|---|---|
| 单行测量（2） | `sk_text_measure` / `sk_text_measure_n` | `runtime.ts:8723–8724` |
| 段落排版（13） | `sk_textlayout_new` / `_new_leading` / `_new_runs` / `_height` / `_max_width` / `_line_metrics` / `_line_box` / `_line_count` / `_paint` / `_delete` / `_glyph_position_at` / `_rects_for_range` / `_caret_rect` | `runtime.ts:8725–8745` |

段落是一个**不透明句柄**（`void*`），C 侧只通过上面 13 个函数查询（高/宽/行数/行盒/光标/
区间矩形）与绘制（`_paint(para, canvas, x, y)`）。**没有一处 C 结构体暴露 SkParagraph 的类型。**

> 这就是 §2.9 铁律（"第三方库链接进来，不内嵌"）的产物：正因为接缝是不透明的 15 个函数，
> "换引擎"才不等于"改架构"。

### 1.2 平台的字体管理器已经是分层的

`vendor/skia_glue.cc` 的 `sk_platform_fontmgr()` 按平台分派：

| 平台 | 实现 | 位置 |
|---|---|---|
| macOS | `SkFontMgr_New_CoreText(nullptr)` | `skia_glue.cc:1240` |
| Windows | `SkAirFontMgr(GDI, DirectWrite)` —— 双层回退 | `skia_glue.cc:1227–1235` |
| web / 无平台 | `SkFontMgr_New_Custom_Empty()` → `SkFontMgr_New_Custom_Data()`（固定字体数据，FreeType 扫描） | `skia_glue.cc:1116–1126` |
| Android（未来） | Skia 现成有 `SkFontMgr_New_Android`（读 `/system/fonts` + `fonts.xml`） | 未接入 |

**这条事实很重要**：它意味着"移动端字体匹配差"**不是**引入 Rust 文本栈的理由——三端都已经
委派给系统字体管理器了。见 §7。

---

## 2. 体积：唯一的算账目标（含一处实测纠正）

### 2.1 归档大小（本机实测，`vendor/skia/lib/`）

| 归档 | macos-arm64 | wasm | windows-x64 |
|---|---|---|---|
| `libicu` | 16.11 MB | 6.98 MB | 15.25 MB |
| `libskunicode` | 16.17 MB | 7.04 MB | 15.37 MB |
| `libskshaper` | 3.55 MB | 3.84 MB | 5.08 MB |
| `libharfbuzz` | 3.48 MB | 3.78 MB | 4.96 MB |
| `libskparagraph` | 0.45 MB | 0.45 MB | 0.75 MB |
| **文本栈小计** | **~39.8 MB** | **~22.1 MB** | **~41.4 MB** |
| `libskia`（对照） | 14.55 MB | 11.89 MB | 35.77 MB |

> 归档大小 ≠ 最终二进制增量（链接器只拉被引用的成员）。下面给实测的最终数字。
> Windows 侧的库名是 `<name>.lib` 无 `lib` 前缀（标配是 MSVC ABI，见 `vendor/provision/README.md`）。

### 2.2 决定性事实：ICU 数据是**一个不可分的 9.71 MB 对象**

```
$ ar tv vendor/skia/lib/macos-arm64/libicu.a | sort -k3 -n | tail -3
  9.71 MB  libicu.icudtl_dat.o     ← 全部 UCD/CLDR/断行/排序/字符集数据，一个大对象
  0.65 MB  __.SYMDEF
  0.14 MB  libicu.uchar.o
   （共 415 个成员，其余都是几十~几百 KB 的代码对象）
```

libicu.a 有 415 个成员，**但数据本身是单对象**。任何一处对 `u_*` API 的引用，都会把这
9.71 MB 整块拉进二进制（除非 ICU 用 `-ffunction-sections` 编过且链接期开 GC——它是预编译
的，没有）。`libskunicode.a` 里**也有一份同名同尺寸的 `libicu.icudtl_dat.o`**。

### 2.3 最终二进制实测（本机，macOS arm64）

| 构建 | 二进制 | `__const` | 含 ICU 数据符号 |
|---|---|---|---|
| `examples/hello.as`（无 Skia） | **0.78 MB** | — | 否 |
| 最小 Skia 程序（自建 `min.cc`：建 surface、画个矩形；**不链 glue**，只链 `-lskia -lskcms -lz -lm`） | **5.43 MB** | — | **否** |
| `examples/textflow.as`（有文本，正常管线） | **18.53 MB** | 10.79 MB | **是** |
| `examples/draw-over.as`（**完全不画文字**，正常管线） | **18.53 MB** | 10.79 MB | **是** |
| 同上 + `-Wl,-dead_strip` | **15.91 MB** | — | **是** |

复现命令与产物在 `temp/textsize/`（`probe`=textflow、`notxt`=draw-over、`minA`=最小程序）。

### 2.4 ⚠️ 纠正：ICU 不是文本路径引入的

**第三行与第四行**是本文最重要的实测结果：

> **一个完全不调用 `flash.text`、只画 `Graphics` 的应用，二进制与有文本的应用一样大
> （18.53 MB），`__const` 都是 10.79 MB，`_icudt69_dat` 都在。**

原因：`vendor/skia_glue.cc` 被编成**一个对象文件** `vendor/skia_glue.o`，里面同时装着图形
与文本两组函数。对象文件是**整份参与链接**的，它引用的 `skia::textlayout::*`（`StrutStyle`、
`FontCollection`、`ParagraphBuilder`…）必须被解析，于是 `libskparagraph.a → libskunicode.a →
libicu.a → libicu.icudtl_dat.o (9.71 MB)` 整链被拉进来，**哪怕这个程序一行字都不画**。
实测：把 glue 用 `-ffunction-sections` 编、链接加 `-Wl,-dead_strip`，**仍然链接失败**
（`Undefined symbols: skia::textlayout::StrutStyle::StrutStyle()`）——ld64 对对象文件仍要求
其未定义符号可解析。

**这条纠正改变了结论的形状**：

1. "换文本引擎以瘦身"**不能只换引擎**——必须同时让 glue **不再引用** SkParagraph，
   也就是把文本 glue 拆成**独立对象/独立源文件**，在不用文本的构建里**根本不参与链接**。
2. 反过来说，**一个零风险的既得收益被漏掉了**：`-Wl,-dead_strip`（当前 `build.ts` 里
   grep 不到任何 `-Wl,-dead_strip`）。实测 **18.53 → 15.91 MB（−2.62 MB）**，与 Rust 无关。
   *（需全量回归验证：ObjC 类别 / `constructor` 属性 / typeinfo 在 `-dead_strip` 下有可能被
   误删；`metal_glue.mm` 有 ObjC 类，必须跑一遍 `node test.ts` 再落。）*
3. 文本栈**真实可省的量级**：18.53 − 5.43 ≈ **13.1 MB**（其中 ICU 数据 9.71 MB、
   skunicode 辅助代码 + harfbuzz + skshaper + paragraph 约 3.4 MB）。

### 2.5 `args.gn` 现状（可裁剪的开关）

`build-tools/skia-src/out/{macos-arm64,wasm}/args.gn` 两个文件都写着：

```
skia_use_icu = true
skia_use_icu4x = false          ← ICU4X 本身是 Rust 的模块化 unicode 库
skia_use_libgrapheme = false
skia_use_harfbuzz = true
skia_enable_skparagraph = true
skia_enable_skshaper = true
```

⇒ 有三条**互相独立**的瘦身路线，见 §9 的横向对比。**换 Rust 文本引擎只是其中一条，而且不是最省事的那条。**

---

## 3. 候选技术栈（Rust 侧）

| crate | 职责 | 对应现在是谁 | 备注 |
|---|---|---|---|
| `rustybuzz` | **整形（shaping）** | HarfBuzz | **是 HarfBuzz 的 Rust 移植** ⇒ 整形行为同源、迁移风险低，但"去掉 HarfBuzz"实际上是"换成 HarfBuzz 的 Rust 版" |
| `ttf-parser` | 字体解析 / cmap / 度量 | FreeType + SkTypeface | |
| `swash` | **光栅化 + 字形缓存** | SkScalerContext + SkGlyphCache | 彩色 emoji（CBDT/sbix）支持偏弱 |
| `fontdb` | 字体枚举 / 家族匹配 | `SkFontMgr` | 三端平台字体管理器已覆盖，见 §1.2 |
| `cosmic-text` | **断行 + 段落 + 缓存** | SkParagraph（UAX#14） | 依赖以上全部 |
| `parley`（备选） | 断行 + 段落 | SkParagraph | 与 `swash` 同属 linebender，更活跃 |

**关键取舍**：整形用 `rustybuzz` 意味着"语义同源"（对 AIR 对齐有利），但**省不掉整形逻辑本身**；
真正省掉的只有 **ICU 的 unicode 数据表**（9.71 MB）与 HarfBuzz/C++ 那份实现。

---

## 4. 接入形态（三档）

| 档 | 做法 | 判断 |
|---|---|---|
| **1. 整体替换**：Rust 出 `(mask, x, y)`，C++ 只做 Skia 画布合成 | 在 `vendor/` 新增一个实现同名 13 个 `sk_textlayout_*` 的 shim，与 `skia_glue.cc` 里的实现**二选一编译**；生成的 C 一行不改 | ✅ **推荐**（唯一能兑现 §2 目标的形态） |
| 2. 只换字体库（`fontdb` 喂给 `SkFontMgr_New_Custom_Data`） | 只换"家族匹配" | ❌ 平台 FontMgr 已覆盖（§1.2），收益 ≈ 0 |
| 3. 双后端并行（Skia 与 Rust 同时链，运行时切换） | A/B 用 | ⚠️ 只适合**暂时性**验证：两份字体栈同时进二进制，体积反而最大 |

**为什么档 1 仍然需要 C++**：`_paint` 的落点是 **Skia 的 `SkCanvas`**（`sk_textlayout_paint(para,
canvas, x, y)`）。Rust 侧把字形光栅成 alpha mask 之后，仍要有人把它合成到 Skia 画布上
（`SkImage::MakeRasterCopy` / `SkSurface`）。所以正确的切法是：

```
Rust：整形 + 断行 + 光栅 → (glyph mask, x, y)      ← 纯 Rust，无 ICU / 无 HarfBuzz
C++ shim：mask → SkImage → canvas->drawImage        ← 仍是 Skia，但只剩"贴图"
```

---

## 5. 具体接入步骤

### 5.1 Rust crate

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

### 5.2 C++ shim `vendor/textglue_rs.cc`

实现**同名**的 13 个 `sk_textlayout_*`，内部转 `rtl_*`；`paint` 把 mask 包成 `SkImage` 再
`drawImage`。与 `skia_glue.cc` 里那 13 个实现用**编译宏二选一**（同一符号不能有两份定义）——
`metal_glue.mm` / `d3d_glue.cc` / `stage3d_webgl.cc` 已经是这个模式（§2.9）。

> **同时必须把 `skia_glue.cc` 的文本段切出去**（§2.4）：只要它还引用 SkParagraph，ICU 就还在。
> 这一步是本文档最容易漏掉、也最关键的一步。

### 5.3 构建清单（已有的 `objects` 字段就够）

```json
{
  "objects": ["../../vendor/rust/libtextlayout_rs.a"],
  "defines": ["ASC_TEXT_RUST=1"],
  "link-paths": ["../../vendor/skia/lib/macos-arm64"]
}
```

字段定义在 `src/build.ts:186–205`；`objects` 落到 `build.ts:738`。**不需要新增任何清单字段。**

### 5.4 链接顺序天然正确

`build.ts:734–741` 的顺序是：`生成 .c → sources（我们的 .cc） → objects（rust .a） → -L → -l →
-framework`。静态归档正好排在"引用它的目标文件"之后——这正是 `build.ts:743` 那条注释
（*"Static-archive order: libraries must follow the objects that reference them"*）在管的约定。

### 5.5 `--air-app` 的自动检测点

`auto-app` 已有同构先例：`detectText`（`air-app.ts:168`）、`detectStage3D`（`air-app.ts:110`）、
`detectAudio`（`air-app.ts:180`）、`findAppFonts`（`air-app.ts:827`）。新增一个 `detectTextBackend`
即可在生成清单时按 target 注入 `objects` + `defines`。

### 5.6 交叉编译矩阵（**真正的工作量在这**）

每个 target 一份 `.a`，对标 `vendor/skia/lib/{macos-arm64,wasm,windows-x64,windows-x86}` 的布局：

| target | Rust target triple | 链接器 | 现状 |
|---|---|---|---|
| macOS arm64/x64 | `aarch64-apple-darwin` / `x86_64-apple-darwin` | `clang++` | ✅ 本机可编 |
| Windows x64/x86 | `x86_64-pc-windows-msvc` / `i686-pc-windows-msvc` | `clang`（MSVC ABI） | ⚠️ 必须与 Skia 一样用 **MSVC ABI**（见 `vendor/provision/README.md` 的硬约束） |
| web | `wasm32-unknown-emscripten` | `emcc` | ✅ 有该 target |
| WASI | `wasm32-wasip1` | `clang --target=wasm32-wasip1` | 无 GUI，不必 |
| iOS（规划） | `aarch64-apple-ios` | `clang` | 待 target 落地 |
| Android（规划） | `aarch64-linux-android` | NDK clang | 待 target 落地 |

### 5.7 建议分阶段（如果要真做）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | **先做 §9 的低风险项**（`-dead_strip`、`skia_use_icu4x`），把体积账先压一遍 | 体积 + 全量回归 |
| P1 | 桌面 **A/B 双后端**（档 3）：同一份 `textfield` 示例跑两遍，用 `adl` 双端报告 diff 出**差异清单** | `flash-text.md` §5.1 数值报告 |
| P2 | 按差异清单逐项校准；差异收敛后切默认 | 差异清单归零（或如实登记） |
| P3 | 移动端 target 落地时，只在该 target 打开 Rust 后端 | 按 target 分层（`compile.md` §4.1） |

---

## 6. 逐端分析（本文核心）

### 6.0 总表

| 端 | 状态 | 现在谁在做文本 | 换 Rust 的**收益** | 换 Rust 的**代价/风险** | 结论 |
|---|---|---|---|---|---|
| **macOS native** | ✅ 已上线 | CoreText（字体）+ SkParagraph（排版）+ 本仓 CoreText 补丁 | 体积 ~13 MB | 丢掉 `skia.md` §6.9 的补丁收益、emoji（Apple Color Emoji）、全部 adl 校准 | ❌ 不做 |
| **Windows native** | ✅ 已上线 | GDI + DirectWrite 双回退 + Uniscribe 整形 | 体积 ~13 MB | 要自建 DirectWrite 等价回退链；emoji（Segoe UI Emoji） | ❌ 不做 |
| **Linux native** | ⛔ 未 provision | —（`vendor/skia/lib/` 无 linux） | — | — | ⛔ 无对象 |
| **web (emcc)** | ✅ 已上线 | `SkFontMgr_New_Custom_Data` + 运行时注入 `font-urls` | 体积（wasm 文本栈归档 22.1 MB；`.wasm` 首屏体积可省 ~7 MB 量级） | 字体注入契约要重做；但**首屏体积收益相对量级最大** | ⚠️ **最有价值的一档** |
| **WASI (raw)** | ✅ 已上线（无 GUI） | **无**（`as_skia_*` 全 0 桩，`runtime.ts:9547+`） | 0 | 0 | ⛔ 不涉及 |
| **iOS**（规划） | ❌ 未开始 | 计划 CoreText（补丁已覆盖 iOS 分支） | 体积 + 纯静态库形态**天然适配**（iOS 无 `dlopen` 问题） | 需先有 target、有 Skia 的 ios 构建 | ⏸ 随 target 一起评估 |
| **Android**（规划） | ❌ 未开始（`--package android-project` 直接报错，`index.ts:997`） | 计划 `SkFontMgr_New_Android` | 体积（APK 敏感）+ 不必自建 `fonts.xml` 解析 | 同 iOS | ⏸ 随 target 一起评估 |

### 6.1 macOS native

- **现在**：`SkFontMgr_New_CoreText` 枚举系统字体；SkParagraph 排版；**外加一处本仓对第三方库
  的补丁**——`vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch` 修的是 CoreText 在
  "同族同 PS 名"的两个字体文件之间换脸（`skia.md` §6.9、`flash-text.md` D-T15）。修后墨掩码对
  `adl` IoU 100%。
- **换 Rust 后**：这条补丁的收益自动消失（Rust 侧不走 CoreText），但会引入自己的字体匹配问题；
  Apple Color Emoji 的彩色渲染由 CoreText 提供，`swash` 在 CBDT/sbix 上偏弱。
- **体积**：~13 MB。
- **结论**：❌ **不做**。收益是纯体积，代价是已经钉住的全部行为。

### 6.2 Windows native

- **现在**：`SkAirFontMgr(GDI, DirectWrite)` 双层回退（`skia_glue.cc:1227–1235`），
  GDI 后端用 Uniscribe 整形（`air-app.ts:676` 注释）。Skia 库有 x64/x86 两套。
- **换 Rust 后**：要自建等价回退链（`fontdb` 读 `C:\Windows\Fonts` 可行，但 DirectWrite 的
  script-aware fallback 要自己写）；emoji 走 Segoe UI Emoji。
- **体积**：~13 MB（41.4 MB 归档 → 约 13 MB 可省，量级同 macOS）。
- **结论**：❌ **不做**，理由同 macOS。

### 6.3 Linux native

- `vendor/skia/lib/` 只有 `macos-arm64` / `wasm` / `windows-x64` / `windows-x86`，
  **没有 linux**（`compile.md` §2 明确"预编译依赖库四套"）。所以 Linux 端目前**没有可分析的文本栈**。
- 若将来 provision Linux：Skia 侧会用 fontconfig（`skia_use_fontconfig` 现在 = `false`），
  Rust 侧的 `fontdb` 在 Linux 上反而更简单。这条留到 Linux target 立项时再说。

### 6.4 web / wasm（emcc）

- **现在**：`SkFontMgr_New_Custom_Empty` → `SkFontMgr_New_Custom_Data`，字体字节由页面 JS
  `fetch` 后经 `Module._sk_fontmgr_register_data(ptr, len)` 注入（`html5-web.md` §4）。
  `EXPORTED_FUNCTIONS` 必须导出该入口（`html5-web.md` §5.2）。
- **这里有一个 web 独有的坑**：沙箱**没有可枚举的系统字体**；`font-urls` 为空 ⇒
  `sk_platform_fontmgr()` 停在 `Custom_Empty` ⇒ **drawString 一个字形都不画**，而编译成功、
  页面能跑、trace 全正常（静默错误，`html5-web.md` §4 的失败形态说明）。
- **换 Rust 后**：字体注入契约要重做一遍（同样的字节要经 wasm 边界交给 Rust 侧），
  但**接缝可以保持同形**：仍是"JS fetch → 注入 → 排版前必须就位"。
- **收益**：wasm 文本栈 22.1 MB 归档 → 大约能省 7 MB 量级。**`.wasm` 体积是首屏下载成本**，
  所以这一档的体积收益**比桌面更值钱**（桌面 13 MB 打在 18 MB 的二进制上，web 7 MB 打在
  通常 5 MB 出头的 `.wasm` 上——相对量级完全不同）。
- **结论**：⚠️ **如果真要做 Rust 文本后端，这是第一顺位**（但要先把 §9 的 `icu4x` 路线比过）。

### 6.5 WASI（`--target wasm --package raw`）

- **不涉及**：WASI 产物是无 GUI 的命令行模块，不含渲染。纯 C 分支下所有
  `as_skia_text_*` 都是**返回 0/NULL 的 inline 桩**（`runtime.ts:9547+`）。
- 换任何文本引擎都不影响 WASI。**0 收益、0 代价。**

### 6.6 iOS（规划）

- `compile.md` §6.1 已把 `--target ios` 列为**规划**取值（`clang --target=arm64-apple-ios`）。
- **Rust 在 iOS 上的形态反而是加分项**：iOS 扩展/组件是**静态链进应用镜像**的，没有 `dlopen`
  这一步（`TODO.md` 的 ANE 条目已记录 iOS 与 macOS 的这一差别）。Rust `staticlib` 正好是这个形态。
- 但字体侧：iOS 也是 CoreText，`skia.md` §6.9 的补丁**已经在 `SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS`
  分支内**——也就是说 iOS 上 Skia 侧的字体匹配已经被我们修好了。
- **结论**：⏸ 不要独立立项，**随 `--target ios` 一起评估**。

### 6.7 Android（规划）

- `--package android-project` 现在**直接抛错**（`src/index.ts:997`：`not yet implemented`），
  `vendor/skia/lib/` 也没有 android 目录。
- 字体侧：Skia 有现成的 `SkFontMgr_New_Android`（读 `/system/fonts` + `fonts.xml`），
  比自己在 Rust 里解析 `fonts.xml` 更省事 ⇒ **字体匹配同样不是理由**。
- **结论**：⏸ 唯一可能让 Rust 文本后端"划算"的场景是 **APK 体积硬约束**（应用商店限制）。
  届时形态应为：**只在该 target 打开**，走 `targets.android` 清单分层（`build.ts:390–396`，
  语义是**替换而非追加**）。

---

## 7. 优势清单（逐条）

| # | 优势 | 量级 / 证据 | 适用端 |
|---|---|---|---|
| A1 | **砍掉 ICU 数据块** | 9.71 MB 单对象，见 §2.2 | 全端 |
| A2 | **砍掉 skunicode + harfbuzz + skshaper + paragraph** | 合计约 3.4 MB（18.53 − 5.43 − 9.71） | 全端 |
| A3 | **纯 Rust 无 C++ 依赖** | 消除 `SK_TRIVIAL_ABI` / `-std=c++17` / MSVC ABI 互链等约束（`html5-web.md` §5.1、`provision/README.md`） | 全端 |
| A4 | **静态库形态适配移动端** | iOS 无 `dlopen`，静态链是唯一形态 | iOS / Android |
| A5 | **整形语义同源** | `rustybuzz` 是 HarfBuzz 的 Rust 移植 ⇒ 迁移风险低于换一门新整形器 | 全端 |
| A6 | **单一引擎跨全端** | 现在 macOS/Windows/web 是**三套**字体管理器 + 两条整形路径 | 全端 |
| A7 | **`cargo` 可复现构建** | 对比 `build-tools/skia-src` 的 gn+ninja 重编（`skia.md` §6.1） | 全端 |

## 8. 劣势与代价清单（逐条）

| # | 代价 | 具体是什么 | 严重度 |
|---|---|---|---|
| B1 | **`adl` 校准全部重做** | `flash-text.md` §2 的 D-T1…D-T21 + `skia.md` §8 那一整段：断行阈值恒 `ceil(ink+4)`、`autoSize` 只 `wordWrap=false` 才改宽、`textWidth` 尾空格口径、字段被缩放时 `textWidth/Height` 的 `sy/sx` 口径、字形只按累积 `scaleY` 缩放……这些**全部钉在 SkParagraph 的行为上** | 🔴 **最贵** |
| B2 | **行盒模型要重推** | `sk_air_line_metrics` + `sk_round_half` + `sk_set_air_strut`（`skia_glue.cc:1393–1445`）——AIR 是 `rhalf(ascent)+rhalf(descent)+leading(px)`、**永不加 line gap**；Skia 是 `ceil(ascent+descent+lineGap)`。这套换算对九个具名字体逐值命中，换引擎后要从零重推 | 🔴 |
| B3 | **字体别名语义** | `sk_family_alias`（`skia_glue.cc:1495`）：`_sans→Helvetica`、`_serif→Times New Roman`、`_typewriter→Monaco`、`NULL→Times`，以及"**未安装的字族回落到平台默认脸**"（`D-T17`，实测差 6 px） | 🟠 |
| B4 | **彩色 emoji** | `swash` 在 CBDT/sbix 位图彩色字体上偏弱；而 CoreText（macOS）、DirectWrite（Windows）都现成支持 | 🟠 |
| B5 | **可装上的字体 ≠ 可枚举的字体** | web 侧的注入契约要重做（§6.4）；native 侧要重建平台回退链 | 🟠 |
| B6 | **丢字形缓存/性能** | 现在 `SkGlyphCache` + Skia 的 glyph atlas 是免费的；Rust 侧要自建（`swash` 有 `scale::Scaler`，但缓存要自己管） | 🟡 |
| B7 | **`skia.md` §6.9 的补丁收益消失** | 那条补丁修的换脸问题在 Rust 侧换一种形式重现（要自己处理"同族同 PS 名"） | 🟡 |
| B8 | **工具链进 CI** | 当前**本机没有 Rust 工具链**（`rustc`/`cargo`/`rustup` 均 `command not found`）；CI 要加 5~6 个 target 的交叉编译 | 🟡 |
| B9 | **许可证核对** | Skia=BSD-3、ICU=Unicode License；Rust 侧 `cosmic-text`/`swash`/`fontdb`/`rustybuzz`/`ttf-parser` 的许可证需逐项核对后再定（**本文未核对**，落地前必查） | 🟡 |
| B10 | **双后端期体积最大** | 档 3（A/B 并行）时期，两份字体栈同时在二进制里 | 🟡 |
| B11 | **全套回归要重跑** | 310 个示例 + `textfield` 双端报告 + `[textwrap]` 等结构钉 | 🟡 |

### 8.1 B1/B2 的实证：这些口径是什么样子

`skia_glue.cc` 的文本段（约 600 行）里，**大部分行数不是"画字"，而是"把 Skia 拽到 AIR 的口径上"**：

```cpp
// AIR 把 line box 的每一半各自四舍五入到 0.5，且永不加字体自身的 line gap；
// Skia 报的是 ceil-ish(ascent + descent + lineGap)。
// 实测（Helvetica 9.24→9 / 2.76→3；Times New Roman 10.6875→10.5 / 2.59375→2.5），
// 四舍五入两半复现了每个具名字体的行高：Courier 12、Courier New 13.5、Menlo 14、
// Monaco 15、Times 12、Times New Roman 13、Arial 13.5、Helvetica 12、Geneva 15。
static double sk_round_half(double v) { return floor(v * 2.0 + 0.5) / 2.0; }
                                                 // skia_glue.cc:1393
```

```cpp
// StrutStyle::leading 在这个构建里根本到不了 line box（实测 leading=4 时两行段落仍是
// 2*model），而且负 leading 会被 Skia 直接 clamp 到 0；所以 leading 必须折进 height。
// 又因为 Skia 按 (height * fontSize / rawFull) 缩放，height 要预乘 rawFull/rawSum。
strut.setHeight((SkScalar)(box * am.rawFull / (am.rawSum * size)));   // skia_glue.cc:1457
```

这两处**不是可以"翻译"的东西，是必须重新用 `adl` 逐个探针量出来的东西**。B2 的严重度由此而来。

---

## 9. 横向对比：不换引擎也能瘦身

**这一节应该先做。** 三种路线互不冲突，成本相差一个数量级：

| 路线 | 做法 | 预期收益 | 风险 | 建议 |
|---|---|---|---|---|
| **L1** | 链接期 `-Wl,-dead_strip`（当前完全没有） | **实测 −2.62 MB**（18.53 → 15.91） | 低（需全量回归验 ObjC 类别/typeinfo） | ✅ **先做** |
| **L2** | Skia 重编：`skia_use_icu=false` + `skia_use_icu4x=true` | 可能砍掉 9.71 MB 的大部分（ICU4X 数据是**模块化、可裁剪**的，且 ICU4X 本身是 **Rust**） | 中（需验 SkParagraph 的断行/bidi 仍对；`build-tools/skia-src` 已有重编流程） | ✅ **L1 之后立刻做** |
| **L3** | Skia 重编：`skia_use_libgrapheme=true` + `skia_use_icu=false` | 更激进（libgrapheme 是极小的 C 库） | 高（**libgrapheme 不做 bidi**，段落方向会退化） | ⚠️ 只有确认不需要 bidi 才可 |
| **L4** | 裁 `air-app.ts` 里 1:1 列出的 codec（`skottie`/`svg`/`dng_sdk`/`piex`/`expat`） | ~2.5 MB | 低 | 已被 L1 部分覆盖 |
| **L5** | **换 Rust 文本引擎**（本文主题） | ~13 MB | **高**（§8 B1/B2） | ⏸ 只在移动端 + 体积硬约束时 |

> L2 值得强调：**ICU4X 是 Rust**。也就是说"用 Rust 的 unicode 库"这个想法**不必**通过替换
> 整个文本引擎来实现——Skia 自己就留了 `skia_use_icu4x` 这个开关，代价只是重编一次 Skia。
> **先用 L2 把 ICU 数据块换掉，再决定要不要动文本引擎。**

---

## 10. 顺带澄清："那前端 TS 要不要转 Rust"

**两件事，不要混。**

| 问题 | 含义 | 影响 | 结论 |
|---|---|---|---|
| A. 产物是什么语言 | 生成 C → 生成 Rust | 运行时架构、体积、语义 | ❌ 不采（有环 GC / `setjmp` 异常 / "可读 C" 三条硬伤） |
| B. 编译器用什么写 | 前端 TS → Rust | 只影响编译器自身的分发 | ❌ 不采（~55k 行可移植，运行时那份 736 KB C 原样保留 ⇒ "转了 Rust 仍生成 C"） |
| C. **本文的**：把某个**原生组件**换成 Rust 静态库 | `vendor/` 多一个 `.a` | 体积 / 免 Node | ⏸ **唯一正当形态，且只在移动端 + 体积硬约束时** |

C 与前两者**正交**：它不碰生成的 C、不碰前端、不碰运行时——只在 `vendor/` 加一个静态库，
经构建清单的 `objects` 链接。这也正是 §2.9 允许的形态。

---

## 11. 触发条件与决策树

```
体积是硬约束？
├─ 否 ──────────────────────────► 不做。文本栈 ≈13 MB 是"能忍"的成本，
│                                 而 §8 B1/B2 的重校准成本远大于收益。
└─ 是
   ├─ 该端有 Skia 的预编译库可重编？
   │  ├─ 是 ──► 先做 L1(-dead_strip) + L2(icu4x)。到这一步通常已经够了。◄── 推荐终点
   │  └─ 否 ──► 先 provision（Linux/Android 都还没 Skia 库）
   └─ L1+L2 之后仍不够？
      └─ 是 ──► 才轮到 L5（Rust 文本引擎），
                且**只在该 target 打开**（targets.<target> 分层，替换语义）
```

**具体触发**（三条同时成立才启动 L5）：

1. `--target ios` 或 `--target android` **已落地**（现在是"规划"，`compile.md` §6.1）；
2. 该端的**体积被外部硬约束**（应用商店 / 首屏预算）；
3. L1 + L2 已执行且**仍不达标**，并留下实测数据。

---

## 12. 附录

### A. 15 个接缝函数（现状全清单）

| # | 函数 | 签名要点 | 现状实现 |
|---|---|---|---|
| 1 | `sk_text_measure` | `(text, size, bold, italic) → double` | `skia_glue.cc:1559`（`SkFont::measureText`） |
| 2 | `sk_text_measure_n` | 同上 + 显式字节数 | `skia_glue.cc:1566` |
| 3 | `sk_textlayout_new` | 平文单样式 | `skia_glue.cc:1624` |
| 4 | `sk_textlayout_new_leading` | + `leading` | `skia_glue.cc:1662` |
| 5 | `sk_textlayout_new_runs` | **富文本**（`sk_text_run[]`） | `skia_glue.cc:1716` |
| 6 | `sk_textlayout_height` | 段高 | — |
| 7 | `sk_textlayout_max_width` | 最长行宽 | — |
| 8 | `sk_textlayout_line_metrics` | 逐行 start/end/top/bottom | — |
| 9 | `sk_textlayout_line_box` | 单行 ascent/descent/left/width | `skia_glue.cc:1904` 附近 |
| 10 | `sk_textlayout_line_count` | 行数 | — |
| 11 | `sk_textlayout_paint` | **绘制到 SkCanvas** | — |
| 12 | `sk_textlayout_delete` | 释放 | — |
| 13 | `sk_textlayout_glyph_position_at` | 点击 → 字符索引 | — |
| 14 | `sk_textlayout_rects_for_range` | 区间 → 矩形集合（选区/下划线） | — |
| 15 | `sk_textlayout_caret_rect` | 光标矩形 | — |

> 另有 **`sk_text_run` 结构体**（`runtime.ts:8456`）**无条件定义**（纯 C 构建也要用）；
> 以及 `sk_canvas_draw_text` / `sk_canvas_draw_text_n` 两条**直接绘制**路径
> （`skia_glue.cc:1542` / `:1551`），它们绕过 SkParagraph，只做单行。

### B. 本机实测数据（2026-10-20，macOS arm64）

| 项 | 值 | 复现 |
|---|---|---|
| 无 Skia 基线二进制 | 0.78 MB | `node src/index.ts examples/hello.as -o temp/textsize/hello` |
| 最小 Skia 程序（不链 glue） | 5.43 MB，**无 ICU 数据** | `temp/textsize/min.cc` + `temp/textsize/minA` |
| 文本示例二进制 | 18.53 MB（`__const` 10.79 MB，含 `_icudt69_dat`） | `temp/textsize/probe`（源 `examples/textflow.as`） |
| **图形示例**（无文本）二进制 | **18.53 MB**（同上） | `temp/textsize/notxt`（源 `examples/draw-over.as`） |
| 同上 + `-Wl,-dead_strip` | 15.91 MB | `temp/textsize/notxt_ds` |
| 同上 + glue `-ffunction-sections` + `-dead_strip` | 15.91 MB（ICU 仍在） | `temp/textsize/notxt_fs` |
| `libicu.icudtl_dat.o` | **9.71 MB（单对象）** | `ar tv vendor/skia/lib/macos-arm64/libicu.a` |
| Rust 工具链 | **未安装**（`rustc`/`cargo`/`rustup` 全部 `command not found`） | — |

> 测量口径：`ls -l` 取字节数 / `size -m` 取段与节大小 / `nm | grep _icudt69_dat` 判 ICU 数据是否进包。
> 产物留在 `temp/textsize/`（scratch 目录，不进仓库）。

### C. 参考

- [`flash-text.md`](flash-text.md) §1（能力盘点）§2（D-T1…D-T21 差距清单）§5（双端报告口径）
- [`skia.md`](skia.md) §2.9（链接不内嵌）§6.1（Skia 重编）§6.4（版本选型）§6.9（CoreText 补丁）
  §7（多目标）§8（文本的两档方案 + 校准史）
- [`html5-web.md`](html5-web.md) §3.1–§5.2（web 渲染、字体注入、`SK_TRIVIAL_ABI`、`EXPORTED_FUNCTIONS`）
- [`compile.md`](compile.md) §2（预编译依赖四套）§4（构建清单）§5（多目标表）§6.1（target × package）
  §6.4（清单扩展字段）
- [`size-optimization.md`](size-optimization.md)（`static` 化 + `-O2` tree-shake）
- `build-tools/skia-src/out/{macos-arm64,wasm}/args.gn`（unicode/整形开关的现状）
- `vendor/provision/README.md`（Windows MSVC ABI 硬约束）