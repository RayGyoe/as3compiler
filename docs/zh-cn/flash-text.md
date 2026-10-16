# 文本显示对齐（`flash.text` / `TextField`）调研与集成方案

> **触发**：真应用 talkmed-meeting 的 AOT ↔ `adl` 差异报告
> （工作区根 `talkmed-meeting-aot-vs-adl-diff.md`，2026-10-14）把 12 项可见差异归并成 4 条根因——
> 其中 **R2（SWC 的 `DefineEditText`/`DefineText` 未烘文本、也未烘 `TextFormat`）** 与
> **R3 的文本项**（`as_str_alloc(1)` 未写终止符、`displayAsPassword` 按字节掩码、字体别名/度量残差）
> 全部落在 `flash.text` 这一个面上。本文是**立项文档**：先盘点现状与差距、给出显示矩阵与示例口径，
> 再把「对齐 `TextField` 这座大山」拆成可逐阶段验收的工作包。
>
> **一句话结论**：`TextField` 的**运行时排版**（SkParagraph / 富文本 / 行度量 / 输入编辑选择滚动）
> 已相当完整，欠的主要是两族——**A. SWC 静态文本与 `TextFormat` 从未烘焙**（最大的一座山，
> 一个改动覆盖 6 处外观差）、**B. 运行时口径缺口**（内存安全、掩码、别名、度量、`TextFormat` 子集）。
> 唯一 oracle 是 **AIR 51.4.1 的 `adl`**，逐值对齐；`adl` 能跑对我们跑不出 ⇒ 遗留缺陷（AGENTS §1.5）。

---

## 0. 范围与非目标

**在范围内**

- `flash.text.TextField` 的**显示**面：文本内容、`TextFormat` 字段、富文本（`htmlText` + `StyleSheet`）、
  行/字符度量、`autoSize`、`displayAsPassword`、`border`/`background`、`textColor`。
- SWC 烘焙的**静态文本字符**（`DefineText` tag 11/33、`DefineEditText` tag 37）：
  烘出初始文本 + `TextFormat`，并让 `SimpleButton` 未定义态不画。
- 支撑上述显示面所需的运行时口径（字符串终止符契约、字体家族别名、`Capabilities.language` 归类到
  「语言」面但仍影响本面文案，见 §2 交叉引用）。

**非目标（另立域）**

- **UTF-16 码元索引**的全面改写（`String.length`/`charCodeAt`/`TextFormat` 全族按字节 ⇒ 全运行时字符串层
  重构）。本方案只保证「**文本显示**在字节口径下自洽且与 AIR 的**可见结果**一致」，长度/索引语义的
  系统性差异保留为既有登记项（见 §2 D-T8）。
- **SWF 内嵌字体**（`DefineFont2/3` + 字形轮廓）的保真：AIR 画 SWC 文本用的是 SWF 内嵌字体，
  我们走系统字体 ⇒ 字形轮廓不可能逐像素相同。本方案只对齐**文本内容、字号、颜色、粗斜、对齐**
  等**可解析**的属性，字形轮廓差在 `notes` 报明（§3.3 明确）。
- morph / `DefineMorphShape`（另一域）。

---

## 1. 现状盘点（已完成的能力）

`TextField` 面不是一个新面——阶段 38 起已累积十余个子阶段。下表是**动工前的盘点**，
避免把已完成的能力当成缺口重做。

| 能力 | 状态 | 落点 |
|---|---|---|
| 单行/多行排版（SkParagraph + HarfBuzz，UAX#14 断行） | ✅ | 阶段 38/44、`vendor/skia_glue.cc` `sk_textlayout_*` |
| `TextFormat` 的子集样式（`font/size/color/bold/italic/underline/leading/align/kerning/letterSpacing`） | ✅（子集） | 阶段 38/72/89·17 |
| 水平对齐（有排版宽交 Skia 逐行；无排版宽由 `as_tf_align_dx` 整块平移） | ✅ | 阶段 89·17/135 |
| 富文本：`htmlText` 子集（`span,p,b,i,u,font,a,li,br,img,textformat`）+ `setTextFormat` 区间 | ✅ | 阶段 72/148 |
| `StyleSheet` 真类 + 块级 HTML 模型（break-after） | ✅ | 阶段 148 |
| `autoSize`（none/left/center/right） | ✅ | 阶段 72 |
| 行度量 `getLineMetrics` / `flash.text.TextLineMetrics` | ✅（逐行） | 阶段 103 |
| 内部几何换算（`as_tf_index_at` 点击落点、光标/选区矩形、逐行 `getLineMetrics`） | ✅（内部） | 阶段 94·15/135 |
| **公开几何/文本查询 API 族**（`getCharBoundaries`/`getCharIndexAtPoint`/`getLineIndexOfChar`/`getLineText`/`getFirstCharInParagraph`/`getImageReference`） | ❌（响亮 `undefined method`） | 本方案 B 包 |
| 可编辑文本：插入点、选择、编辑键、`restrict`、`displayAsPassword` 遮罩渲染 | ✅ | 阶段 94·7/94·8/135 |
| 滚动 `scrollV`/`maxScrollV`/`scrollH`/`mouseWheelEnabled` | ✅ | 阶段 38/135 |
| `border`/`borderColor`/`background`/`backgroundColor`/`textColor` | ✅ | 阶段 94·8 |
| 字体家族别名翻译（`_sans`→Helvetica、`_serif`→Times New Roman、`_typewriter`→Monaco、NULL→Times） | ✅ | 阶段 94·20、`vendor/skia_glue.cc` `sk_family_alias` |
| 行盒模型（AIR 半像素取整、丢 line gap、leading 折进） | ✅（≤0.5px 残差） | 阶段 94·20/135 |
| SWC：`DefineEditText`/`DefineText` **占位子件**（存在性/个数正确） | ✅（**空壳**） | 阶段 95·八 |
| SWC：`DefineEditText`/`DefineText` 的**初始文本 + `TextFormat`** | ❌ | 本方案 A 包 |
| SWC：`SimpleButton` 未定义态（`upState == NULL`）不画 | ❌ | 本方案 A 包 |

---

## 2. 差距清单（逐项：现象 / 根因 / 代码位置 / 证据）

编号 `D-T*` 与差异报告的 `D*` 交叉引用。凡 `adl` 能跑对而我们跑不出 ⇒ **遗留**（AGENTS §1.5）。

### A. SWC 静态文本与 `TextFormat`（最大的山）

| # | 现象（adl vs 我们） | 根因 | 代码位置 | 证据 |
|---|---|---|---|---|
| **D-T1** | 页脚两行 `eDoctor Healthcare Communications.` / `meeting.talkmed.com` **整行丢失**；协议行《隐私政策》/《服务协议》文案缺失 | `DefineEditText`/`DefineText` **只烘一个空 `TextField`**，初始文本从不解码 | `src/swc.ts` `SwcText`（§`CHARACTER_TAG_KINDS`）；`src/emit.ts` `as_swc_new` 的 text 分支（`case ${ch.id}: { TextField* t = TextField_new(); t->_fieldWidth=…; }`） | 差异报告 D2；`temp/cmp/shots/P2_*` |
| **D-T2** | SWC 内建字段的拉丁文本呈**衬线**（Times-ish），adl 无衬线 | 占位 `TextField` 的 `defaultTextFormat` 是 `TextField_ctor` 的 `TextFormat_new(NULL,12,…)` ⇒ `font == NULL` ⇒ `sk_family_alias` 落 Times | `src/emit.ts:16177`（`o->defaultTextFormat = TextFormat_new(NULL, 12.0, …)`） | 差异报告 D2 |
| **D-T3** | SWC 内建字段**左对齐**（tab 标签偏左 ≈52px），adl 半栏居中；`登录` 呈**黑**，adl 青绿 | 同上：`align == NULL` ⇒ `as_tf_align_index` 返回 0；`color == 0x000000` | `src/emit.ts:16215` `as_tf_align_index` | 差异报告 D2、`cmp_tabs.png` |
| **D-T4** | `SimpleButton.upState == NULL` 时画出 **down/hit 态**（两个灰块），adl 什么都不画 | 烘焙的按钮 `up=NULL; over=NULL;`，渲染回退到了 down/hit | `src/emit.ts` `as_swc_build_87` 区；`SimpleButton` 渲染分支 | 差异报告 D3 |

> **杠杆点**：D-T1/2/3 **同一个改动**（在 SWC 侧解码 `DefineEditText` 的 `HasText/initialText`、
> `FontHeight/HasFont/TextColor/Align/Layout/Leading` 与 `DefineText` 的 `TEXTRECORD`，
> 烘成 `t->text = …` + `t->defaultTextFormat = TextFormat_new(font, size, color, bold, italic, leading, align)`）
> 一次覆盖 6 处外观差。**这是本方案工作量最大、收益也最大的一项。**

### B. 运行时口径缺口

| # | 现象 | 根因 | 代码位置 | 证据 |
|---|---|---|---|---|
| **D-T5** | 空 `TextField` 会渲染出「上一条文本布局」的残留（`MS: 17` / `_sans`，每次运行不同） | `TextField_ctor` 用 `o->text = as_str_alloc(1)` —— 1 字节、`gc_alloc` 对 `GCT_STRING` **故意不清零**、**未写终止符**，`strlen` 一直读到该 GC 块上次残留 → 违反 `as_str_alloc` 的契约（调用者写 NUL） | `src/emit.ts:16140`；契约在 `src/runtime.ts:968`。同类：`src/emit.ts:12789/12791`（`Socket__str`） | 差异报告 D4（决定性实验：给它设红/粗/等宽格式但文本空 ⇒ 乱码变红色等宽） |
| **D-T6** | 密码框占位按**字节**掩码（`请输入密码` 5 汉字 → 15 星号），adl 5 颗；星号颜色我们黑、adl 灰 162 | `as_tf_layout_text` 逐**字节**替换（一个星一字节），而 AIR 按 **UTF-16 码元** | `src/emit.ts` `as_tf_layout_text`（`m[i] = (c=='\r'||c=='\n') ? c : '*'`） | 差异报告 D9、`cmp_pwd.png` |
| **D-T7** | `_sans`/`_serif` 通用别名的**行高**与 AIR 不同（我们 12/13，adl 15.5/15）；`textWidth` 行尾空格不计（AIR 计）；字形进位 ≤0.5px 残差 | AIR 对三个通用别名用**自有非线性设备字体度量表**，无可解析字面能复现 | `vendor/skia_glue.cc` `sk_air_line_metrics`/`sk_round_half` | 遗留表「`_sans`/`_serif` 行高」「`textWidth` 不含行尾空格」「字形累进残差」三行 |
| **D-T8** | `String` 是 **UTF-8 字节索引**（非 UTF-16 码元）：`"中".length` 我们 3、adl 1；`displayAsPassword` 星号数、编辑索引同源 | 运行时字符串表示的直接后果 | `src/runtime.ts` 字符串层 | 遗留表「UTF-8 字节索引」行（**非本方案目标**，见 §0） |
| **D-T9** | `TextFormat` 字段是子集：缺 `leftMargin`/`rightMargin`/`indent`/`blockIndent`/`bullet`/`display`/`tabStops`/`url`/`target`；ctor 只收 6 参（AIR 11 参） | 未建模 | `src/symbols.ts` `TextFormat` classMap | 遗留表「`TextFormat` 字段是子集」行（**响亮报错**，非静默） |
| **D-T10** | 多行 run 的**行高偏大约 1.5×**；规则里的 `leading` 未折进 run；`getLineText` 未实现 | 富文本行盒逐 run 的证据采集不完整；`as_ss_str(rule,"leading")` 未读 | `src/emit.ts` htmlText/run 路径 | 遗留表「htmlText 多行 run 行高」行、阶段 148 |
| **D-T11** | `TextField.textWidth` 不含行尾空格（AIR 含）；字形累进口径 ≤0.5px 残差 | 取哪些字形 / 进位舍入 | `vendor/skia_glue.cc` 度量路径；`as_tf_*width*` | 遗留表两行 |
| **D-T12** | 公开几何/文本查询 API 族**完全未实现**（`getCharBoundaries`/`getCharIndexAtPoint`/`getLineIndexOfChar`/`getLineText`/`getFirstCharInParagraph`/`getImageReference`）——调用处响亮 `undefined method` | 只有**内部**换算（`as_tf_index_at`、`as_tf_line_*`），没有把它们暴露成 AIR 的公开 API；方法表里只有 `getLineMetrics`/`appendText`/`setSelection`/`setTextFormat`/`getTextFormat` | `src/symbols.ts` `TextField` classMap 的 `methods`；`src/emit.ts` 的 `as_tf_*` 几何助手 | TODO 遗留表「`getLineText` 未实现」；本仓 `grep` 全树 0 命中 |

### D. 字体「换脸」：同族同 PS 名的两个字体文件（阶段一百六十七，✅ 已修）

| # | 现象 | 根因 | 代码位置 | 证据 |
|---|---|---|---|---|
| **D-T15** | 同一份源码，`adl` 画 `创建同传`，我们画 `初开名伤`；**ASCII/拉丁完好，其它 CJK 字族（PingFang SC、华文细黑）也完好**，只有字族 `微软雅黑` 中招 | CoreText 在 `SkCTFontCreateExactCopy` 里用**只有属性的 descriptor** 重拷 CTFont，CoreText 于是按**字族**重新解析脸；本机 `微软雅黑.ttf`（Regular）与`微软雅黑粗体.ttf`（Bold）**同族、同 PS 名**，它挑到了另一个文件——两文件字形序在 index 110 处分叉 ⇒ 每个 CJK gid 画成**下一个字**（拉丁 gid 两文件一致故无损） | **第三方库补丁**（非我们生成 C）：`vendor/skia/patches/skia-m124-ct-exact-copy-keep-face.patch` → `src/utils/mac/SkCTFontCreateExactCopy.cpp`；原理与证据全文见 [`skia.md`](skia.md) §6.9 | 双端同源探针 `temp/tfswc/`（`BitmapData.draw()`+`getPixels()` 裸 ARGB）：修后 `微软雅黑`/`Microsoft YaHei`/`华文细黑` 墨掩码 **IoU 100.00%**（vs `adl`）、PingFang SC 97.24%；`ctprobe3..6.mm` 定位换脸、`skgl.mm` 证明是光栅化侧；回归钉子 `unit: build/SkiaLocalPatch`（守补丁出处） |

> 该缺陷**不是**取形/ cmap / 字库缺口（三方 shaping 给出的 gid 都正确），也**不影响** wasm/Windows
> 后端（补丁在 `SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS` 分支内）。复现依赖本机装了那一对同族同 PS 名的
> 字体，CI 机器没有 ⇒ **不设 examples 断言**。

### E. `autoSize` 的大小口径 + 装不上的字族的兜底脸（阶段一百六十八，✅ 已修）

| # | 现象 | 根因 | 代码位置 | 证据 |
|---|---|---|---|---|
| **D-T16** | AI 同传列表项 `title`（皮肤字段，字体 `MiSans Regular`、`wordWrap=true`）在 app 的赋值顺序（`autoSize=LEFT` → `text=…`）下**被断成三行并压住同一子件的 `ctime`**，adl 只有一行 | `autoSize` 的宽度适配用了「**已换行**排版的最长行宽」`+4` ⇒ 宽度一收、可用宽正好等于文本宽 ⇒ 下次排版再断一行、最长行更短 ⇒ **每次绘制再收一圈**（实测 290 → 64.66 → 50.66 → 36.66 → 32）。adl 的口径：`wordWrap=true` 时宽度**不动**、只 `height = textHeight + 4`；`wordWrap=false` 才 `width = textWidth + 4`（两个方向） | `src/emit.ts` `as_tf_apply_autosize`（`if (!tf->wordWrap) tf->_fieldWidth = tw + 4.0;`）+ `as_do_extents` 里补的「几何读取也刷新 autoSize」 | 双端同源探针 `temp/tfswc` case ⑥⑦⑧⑩（AOT 侧修后与 adl **逐字相同**）；`examples/autosize-metrics.as`；`unit: display/AutoSizeMetrics` |
| **D-T17** | 同上列表项的**行高**：我们 20（size 14）／adl 14，`ctime.y` 因此低 6px；同类：`宋体`、`MiSans`、任意未安装字族的 16px 行盒我们 22、adl 16 | 未安装的字族我们交给 Skia ⇒ `matchFamilyStyle` 返回 NULL ⇒ SkParagraph 按**供字形的 CJK 层**取行盒（PingFang/Songti SC 1.4em）；AIR 用**平台默认脸**（Helvetica）的行盒 | `vendor/skia_glue.cc` `sk_family_alias`（装不上就换成 `matchFamilyStyle(nullptr)` 的族名，带缓存）+ `sk_match_typeface` 的兜底 | `temp/tfswc` case ⑨⑩（`MiSans Regular`/`宋体` 16px 行盒 16 = adl；修前 22）；`famprobe.mm`（两个名字在本机 `matchFamilyStyle` 都返回 NULL）；`examples/autosize-metrics.as` ④ |

> **注**：`§2C` 的 **N3**（`autoSize` 会回填字段盒，adl `auto-left` → `52×19.5`、我们仍 `100×100`）正是 D-T16 的同一处
> 缺陷在无绘制路径上的表现，现一并修好（`width`/`height` 读取即刷新）。
> 不依赖 app 字体：`adl` **也不注册** app 包里的 `MiSans-Regular.ttf`，所以「给 native 注册 app 字体」
> 会与 oracle 分道扬镳——本阶段刻意不做。

### F. 字段被缩放时的度量与字形口径（阶段一百六十九，✅ 已修）

| # | 现象 | 根因 | 代码位置 | 证据 |
|---|---|---|---|---|
| **D-T18** | AI 同传列表项卡片比 `adl` 高 **2.5pt**：同一子件 `ctime` 的 `textHeight` 我们报 `14.00`、adl 报 `11.45`（app 用 `bg.height = ctime.textHeight + ctime.y + title.y` 直接传导）。`ctime` 的 SWC placement 带 **scaleX = 1.2246**（scaleY = 1） | `textWidth`/`textHeight` 我们直接返回**本地排版的名义值**（等于不认 scale），而 AIR 报的是「**名义 × scaleY / scaleX**」——**两个方向同除 scaleX**（不是各除自己那个轴），且 scale 取**自己 + 全部祖先**的**累积**值（父容器 scaleX=2 时子字段同样减半） | `src/emit.ts`：新增 `as_disp_chain_scale`（沿 `parent` 链按 `T·R·S·transform.matrix` 累乘线性部分）+ `as_tf_scale_ratio`（`sy/sx`），`TextField_get_textWidth`/`TextField_get_textHeight`（含纯 C 兜底分支）都乘上它 | `adl 51.4.1` 双端同源探针 `temp/tfswc` case ⑯⑯b（size 12，名义 166.00/12.00）：`(2,1)→83.00/6.00`、`(1,2)→332.00/24.00`、`(2,2)→166.00/12.00`、`(0.5,1)→332.00/24.00`、`(1,0.5)→83.00/6.00`、父容器 `scaleX=2→83.00/6.00`；修后我们 `166.10/12.00`、`83.05/6.00`、`332.19/24.00`…（宽度只剩 `MiSans` 固有的 0.06% 差、高度**逐字相同**）；`examples/tf-scale-metrics.as` + `unit: display/TfScaleMetrics` |
| **D-T19** | 同一子件 `ctime` 的文字比 `adl` **宽 22%**（`开始时间: 2023-02-10 17:50:00` 我们 204pt／adl 170pt），即 placement 的 scaleX 被拿去**横向拉伸字形** | 非均匀 CTM 直接作用于文本（Skia 会按 `sx` 拉伸字形与字距）。AIR 的字形**只按累积 `scaleY` 整体缩放、`scaleX` 完全不拉宽**——盒子仍按 `scaleX` 变宽（`width` = 本地宽 × scaleX） | `src/emit.ts` TextField 绘制的字形 pass：`clipRect` **之后**把 CTM 后乘 `scale(sy/sx, 1)`（夹在 clip 之后是故意的：Skia 的 clip 按调用时 CTM 映射，可见盒要按 scaleX）；比值取「**最终落点 CTM**」（`ASC_bake_ctm_*`，与边框 1px 同口径），烘焙/`draw` 下自动退化为 1 | `temp/tfswc` case ⑯ 现场截图 + ⑯c/⑰b 裸 ARGB：`(2,1)`、`(0.5,1)`、父 `scaleX=2` 的 ink 宽都 = 165.0pt（= 未缩放），`(1,2)` = 329.5pt（= 2 倍）；`draw(字段)`/`draw(容器)` **都忽略被画对象自身的 transform**（adl 实测 scaleY=2 与未缩放**逐字节相同**），故缩放只能挂在**中间 Sprite** 上量 |

> 这两条是**同一个窗口**（AI 同传列表项 `subtitleskin`）的第三批残差：阶段一百六十七修表头字形、阶段一百六十八修列表项
> 换行/行盒，本阶段修 `ctime` 的缩放口径。**刻意不做**：把 placement 的 scale 暴露进 `DisplayObject.scaleX`
> （adl 报 `ctime.scaleX = 1.2246`，我们仍报 1.0）——那会动到九宫格那套既有口径，属另一条已登记的
divergence（见 [`swc.md`](swc.md) §9.2 F5 与 AGENTS.md 的 SWC 实测口径①）。副作用如实报明：**带 `autoSize`
> 且被运行时缩放**的字段，`width` 仍按「本地名义 extents + 4」再乘 scaleX（adl 是「(名义/sx) + 4 再乘 sx」），
> 例：`scaleX=1.2246` + `autoSize=LEFT` 时我们 `208.30`、adl `170.90`（皮肤子件因 placement 不进 `scaleX`
> 故恰好只有 0.9pt 差）⇒ 记在差异清单的同类残差里，不在本阶段处理。

### G. 文本子件在 placement 下的 `x`/`y`（RECT 原点）与 `TextFormat` 的「未设字段」（阶段一百七十）

| # | 现象 | 根因 | 代码位置 | 证据 |
|---|---|---|---|---|
| **D-T20** | AI 同传列表项的 `ctime` 比 `adl` **左 12pt**（真窗口 ink 起点 `30 vs 54` 设备像素），卡片高与字宽都已对齐后，它是该窗口**最后一条**残差 | SWC 烘焙把文本子的 `RECT` 原点当成**平移量**（`x = matrix.tx + xmin`），而 AIR 把原点当作**角色自己空间里的一个点**：先走 placement 的**线性部分**，再把结果落到它的 **twip 栅格**（1/20 px）——`x = round20(tx + a·xmin + c·ymin)`、`y = round20(ty + b·xmin + d·ymin)`。老口径在**单位缩放**的子件上与 AIR 逐字相同，故 `temp/childfx` 的 99 个子件（全为 scale 1）测不出来 | `src/emit.ts`：新增 `Emitter.swcTextChildXY(m, ox, oy)`，帧 1 的 `emitSwcPlacement` 与时间轴 modify 两条路径都收敛到它；`src/swc.ts` 的接口注释同步 | `adl 51.4.1` 双端同源探针 `temp/tfswc` case ⑰：`subtitleskin.ctime` 老 `0.30` / 新 `11.9913→12.0000` / adl **`12.0000`**；另三个判别例 `filesskin.tab1` `0.0500`、`filesskin.tab2` `90.1000`、`logintabskin.tab1` `0.0000`（老口径分别 `-0.40`/`89.65`/`-0.10`）修后六行逐字相同；钉 `unit: swc/TextChildOrigin`（7 钉，变异后转红）；真窗口 `ctime` ink `53..393` vs adl `54..394` |
| **D-T21** | 同一轮登记、**未修**：① `defaultTextFormat = new TextFormat()`（字段全 null）在我们这里把字体/字号/颜色/粗体/`leading` 全抹成默认值，`adl` 则**一个字段都不改**（等于没设）⇒ 丢掉 SWF 声明的 `leading=2`（`textHeight` 名义值 `14.02 → 12.00`）、`dtf.size = null` 更得到 `size=0` 的退化版面；② `TextFormat` 成员表缺 `indent`/`blockIndent`/`bullet`/`tabStops`/`target`/`url`，构造器 **6 参 vs AIR 13 参** ⇒ AIR 合法的代码我们**编不过** | ① 字段类型是 `number`/`bool`，**表达不了「未设」**，setter 又是整体覆盖；② 成员表/构造器没按 AIR 的类文档补全 | 未改（修法方向：字段改用能表达「未设」的表示 + setter 逐字段「未设则保持」合并 + 补 6 个成员与 13 参构造器） | `temp/tfswc` case TF0–TF8（`adl` 侧）：TF7 全 null 的 `TextFormat` 读回**原值**（我们 `font=null size=12 color=0 bold=false lead=0`）、TF2 换 `dtf` 后 `th` 我们 `9.80` vs adl `11.45`、TF3/TF4 显式 `leading=0/2` 两端一致（`9.80/11.45`，证明差只在「未设」这一态）、TF5/TF8 证明 `adl` 对 `size`/`leading` 的 null **保持原值**；`indent` 在我方 `Codegen error: undefined field 'indent' on class 'TextFormat'`。差异清单 **D41 / R28**，遗留表已登记 |

> **口径教训（值得记）**：D-T20 躲在「99 个子件逐项对齐」的验收背后 —— 那轮采样**全是单位缩放**，
> 而两种口径只在 placement 带缩放时才分叉。**采样的覆盖维度**（此处 = 缩放）与**样本数量**同等重要。
> D-T20 **已修**（阶段一百七十 / v0.4.141），D-T21 **本轮只登记实测**：它改的是 `TextFormat` 的默认值通路
> （触及全部文本示例与皮肤字段的初始版面），须单开阶段 + 全量回归。

### C. 首次实测新发现（`examples/textfield` 双端报告，2026-10-14）

双端报告逐行 diff（`temp/textfield-oracle/{adl,aot}.txt`，**79 例**）暴露出 8 项 §2 A/B 表未覆盖的
**新差异**（编号 `N*`，回填进对应待修项）：

| # | 现象（adl → 我们） | 归属 | 备注 |
|---|---|---|---|
| **N1** | `defaultTextFormat.align` 默认值：adl `"left"` → 我们 `null` | 新，B 包 | 影响**每一条** case 行（差异行数因此被放大） |
| **N2** | `font=null` 时 `defaultTextFormat.font`：adl 报 `"Times Roman"` → 我们报 `null` | 新，B 包 | 只影响读回值（渲染已是 Times） |
| **N3** | ~~`autoSize` 会**回填字段盒**：adl `auto-left` → `52×19.5` → 我们仍是 `100×100`~~ **✅ 已修（阶段一百六十八，见 §2E D-T16）** | 新，B 包 | `textWidth/Height` 正确，差在**字段自身** `width/height`；`width`/`height` 读取现在都会刷新 autoSize |
| **N4** | `displayAsPassword` 的 setter **不使既有排版失效**：先 `text` 后设密码，adl `tw` 仍是**明文**宽（`WWWWWW` → 67.50 = `plain-W`）；先设密码后 `text` 才是**星号**宽（28.00） | 新，**收窄 D-T6** | 我们**恒按星号**排版 ⇒ 设置顺序在 adl 可观测、我们不可观测 |
| **N5** | 星号字形宽度我们与 adl **一致**（6 星 `28.02` vs `28.00`） | 收窄 D-T6 | 差的只有**计数口径**（CJK 按字节 ⇒ 3 星）而非字宽 |
| **N6** | `_sans`/`_serif` 行高在**每个** case 上体现（`th` 12 vs 15.5 / 13 vs 15）；行尾空格（`trail-space1` 27.35 vs 30.50）；字形进位（`W` 67.96 vs 67.50、`i` 16.00 vs 15.50） | D-T7 / D-T11 | 确认既有登记项 |
| **N7** | `BitmapData.draw()` **不 alpha 合成**：目标位图已有的内容被源**逐像素覆盖**。同是 `new BitmapData(w,h,false,0xFFFFFFFF)` + `draw()`，adl 的底在 draw 之后**仍是白的**（`alpha>=8` 的像素占 100%），我们只剩源本身有墨的那 4.2%（其余写成了 `0x00000000`） | 新，**`BitmapData` 面**（由 §5.2 的 UI 通道发现） | 实测定案（两端 `textfield-grid.raw` 逐像素统计）；`src/emit.ts` `BitmapData_draw` 采样尾 `dp[…] = (sa<<24)\|\|…` 无条件写 |
| **N8** | `Graphics.lineStyle(0, …)` 到底画不画 hairline？我们按 `hasStroke = thickness > 0` 判**无描边**；AIR 侧**未实测** | **待查**（`Graphics` 面） | 网格最初用 `lineStyle(0)` 画字段盒，**我们侧完全没画出来**；为避免把两条口径混在一起，harness 改用 1 |

> **D-T6 根因收窄**：不是「星号字宽不对」，而是两点——① AIR **每 UTF-16 码元**一个星（我们每字节）；
> ② AIR 的 `displayAsPassword` setter **不重排**（我们每次排版都重算星号串）。②是本 app 里
> `tf.text=…; tf.displayAsPassword=true;`（常见顺序）看不到星号的原因。

**D-T13 `htmlText` 不解码 HTML 字符引用** ✅（阶段一百四十九已修）

- **现象**：talkmed 页脚第二行是 ` &nbsp;&nbsp;…&nbsp;meeting.talkmed.com`，修前把 `&nbsp;` 当可见
  字符画出（8 组即 48 个字符宽）。AIR 把命名实体与数值引用都解成真字符。
- **根因**：`as_tf_html_set` 的纯文本累积只做逐字节拷贝（`out[opos++] = html[i]`），完全没有实体分支。
- **修法**：新增 `as_tf_html_entity`（命名 `&amp; &lt; &gt; &quot; &apos; &nbsp;` + 十进制/十六进制
  数值引用；拒绝 0 与代理区），在 `&` 处分派。
- **验**：`examples/textfield` 三例对 `adl` —— `html-entity-nbsp` 20.00/20.02、`-named` 55.50/55.51、
  `-numeric` 32.00/32.00。

**D-T14 `DefineEditText` 整张字段未解码** ✅（阶段一百四十九已修，即 §4 的 T2a）

- **现象**：皮肤里**每一行字**都缺失（talkmed 的协议段落 / 页脚 / 按钮文案）；子件个数与索引是对的，
  只是字段为空。
- **根因**：`swc.ts` 只读文本字符的 `RECT`，`SwcText` 没有文本与格式；`as_swc_new` 的 `'text'` 分支
  建的是空 `TextField`。
- **修法 / 坑 / 验**：见 §9「T2a」。两个格式坑：flags 必须按 **MSB-first 16 位字**读（不是 LE `UI16`）、
  `TextColor` 是 **RGBA**。

### 交叉引用（不属本面，但由同一份报告暴露）

- `Capabilities.language` 不返 `zh-CN` ⇒ 整站切英文（报告 D1/R1）。**归类到「语言」面**，
  不重复立项；本方案只在其影响**文案**时引用。
- `System.totalMemory` 量级（报告 D6）、`BitmapData→Bitmap` 画不出（D5）、`NativeWindow.bounds/title`
  （D7/D8）、`SharedObject` 域（D11）——各自独立域。

---

## 3. 显示矩阵（`examples/textfield` 示例必须覆盖的情形）

「测试所有 textfield 显示情况」= 把 `TextField` 的**显示自由度**做成一维/二维矩阵，逐格产出一条
**可 diff 的报告行**（`adl` 与 AOT 用**同一份程序、同一份报告格式**，逐行对照）。

| 维度 | 取值 |
|---|---|
| `type` | `dynamic` / `input` |
| `multiline` × `wordWrap` | 4 组合 |
| `autoSize` | `none` / `left` / `center` / `right` |
| `align` | `left` / `center` / `right` / `justify` |
| 文本内容 | 空、单行、含 `\n`/`\r`、长句软换行、**行尾空格**、行首空格、`\t`、CJK、混排、emoji |
| 字体 | `NULL`（默认）、`_sans`、`_serif`、`_typewriter`、`Arial`、`Helvetica` |
| 样式 | `size`、`color`、`bold`、`italic`、`underline`、`leading`、`kerning`、`letterSpacing` |
| 富文本 | `htmlText`（`b/i/u/font/br/p/span/li`）、`StyleSheet` 规则、`setTextFormat` 区间 |
| 密码/限制 | `displayAsPassword`（ASCII / CJK）、`restrict`、`maxChars`、`condenseWhite` |
| 盒装饰 | `border`/`borderColor`/`background`/`backgroundColor`/`textColor` |
| 度量 | `textWidth`/`textHeight`/`numLines`/`maxScrollV`/`getLineMetrics`(逐行)/`getCharBoundaries` |

**报告格式**：每格一行 `case=<name> tw=<..> th=<..> nl=<..> lh=<..> x=<..> …`，
数值用固定小数位（避免浮点尾差噪声）；`getLineMetrics` 逐行展开。两端**逐行对照**，
差异行即待对齐项（harness 见 §5）。

**两个通道**：数值报告（§5.1，逐行 diff，**是判定依据**）+ 并排网格图（§5.2，同一批用例的
可视截图，**给人眼看**——颜色/粗斜下划线的形状/字形家族/tab 宽度只在那一侧可见）。

**SWC 静态文本**另起一个需要 `.swc` 的探针（D-T1/2/3 需要素材），不放进无素材的矩阵示例。

---

## 4. 集成方案（阶段划分）

按「改动小×影响大」排序，每阶段一个 patch 版本号（AGENTS §2.7），收尾 = 全量 `node test.ts` + 文档 + 版本。

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **T1** | **内存安全**：`as_str_alloc(1)` 三处补写终止符（`TextField_ctor`、`Socket__str` ×2）；加源级钉「`as_str_alloc` 调用必须写满 `n+1` 字节或走 `as_str_dup("")`」 | 无 | 空字段不再出残渣；`test/unit/` 新钉 |
| **T2** | **SWC 文本烘焙**：解码 `DefineEditText`（flags/`HasText`/`FontHeight`/`TextColor`/`HasFont`/`FontClass`/`Layout`/`InitialText`）与 `DefineText`（`TEXTRECORD` + 码表）→ 烘 `t->text` + `t->defaultTextFormat`（含 `align`）；`SimpleButton` `upState==NULL` 不画 | T1（新文本不得是脏串） | talkmed 页脚/协议行/字体/对齐六处对齐 `adl`；`examples/textfield` 增 SWC 用例 |
| **T3** | **`displayAsPassword` 码点掩码** + 占位灰 | 无 | 5 汉字 → 5 星（灰）；`temp/pwdhtml` 口径回归 |
| **T4** | **`TextFormat` 补字段 + ctor 11 参**（`indent`/`blockIndent`/`leftMargin`/`rightMargin`/`bullet`/`tabStops`/`url`/`target`） | 无 | 逐字段对 `adl` 实测后落地 |
| **T5** | **富文本行盒**：`getLineText` + 规则 `leading` 折进 run + run 行盒口径 | T4 | 行高对 `adl` 收敛（`temp/ssprobe` 复测） |
| **T5b** | **公开几何/文本查询 API 族**：`getCharBoundaries`/`getCharIndexAtPoint`/`getLineIndexOfChar`/`getLineText`/`getFirstCharInParagraph`/`getImageReference`（把内部助手暴露成 AIR 形状） | T5（`getLineText` 与行盒同批） | 逐方法对 `adl` 探针；`examples/textfield` 增用例 |
| **T6** | **度量残差**：`_sans`/`_serif` 设备度量表、（可选）`textWidth` 行尾空格、字形进位 | 无 | 逐尺寸/逐串对 `adl`；残差若不可复刻则文档明示 |

> T2 是「大山」本体；T1 先行是因为 T2 往空字段写文本后，**任何**未终止的字符串都会立刻可见。

---

## 5. 验收口径（`adl` 双端报告 diff）

**唯一 oracle**：`adl`（AIRSDK 51.4.1，`adl app.xml`）+ `mxmlc` 参考编译器。

### 5.1 数值报告（判定依据）

- `examples/textfield/Main.as` 是**同一份程序**，两端都跑：AOT 走 `node src/index.ts examples/textfield/Main.as --run`；
  `adl` 走 `examples/textfield/run-adl.sh`（`mxmlc` 编 SWF → `adl`）。
- 两端把报告写到**各自**的 `File.applicationStorageDirectory`（AIR：`~/Library/Application Support/<app-id>/Local Store/`；
  AOT：`~/Library/Application Support/as3aot/Local Store/`），由脚本收集到 `temp/textfield-oracle/{adl,aot}.txt`，
  再逐行 diff。
- 差异行 = 待对齐项，逐项回填本文 §2 表（`adl` 能跑对 ⇒ 遗留；`adl` 报错/不存在 ⇒ 增强）。

**报告格式契约**（两端必须逐字相同，数值固定小数位）：

```
# textfield-probe v1
case=<label> type=<..> ml=<0|1> ww=<0|1> as=<..> align=<..> font=<..> size=<..> tw=<%.2f> th=<%.2f> nl=<..>
line=<case> i=<n> asc=<%.2f> desc=<%.2f> lead=<%.2f> w=<%.2f> h=<%.2f> x=<%.2f>
```

### 5.2 并排网格图（给人眼看，不作判定）

报告只量**数值**——它看得见 `textWidth`，看不见**颜色**（`textColor` / `<font color>` /
`borderColor` / `backgroundColor` 一个都没进报告）、看不见粗/斜/下划线的**形状**，也看不见字形
本身（衬线 vs 无衬线、CJK 回退、`\t` 的宽度）。第二条通道把同一批用例铺成一张**带标签的网格图**，
两端各出一张、并排拼起来。

- **口径**：两端跑**同一段 AS3**（`Main.as` 的 ui 模式），唯一差别是光栅器（AIR 自带 vs Skia）。
  不开窗口、不截图、不管进程：`BitmapData.draw(this)` 光栅化到离屏位图，`getPixels()` 取原始像素，
  连同 ASCII 头写成 `textfield-grid.raw`（每像素 4 字节 `A,R,G,B`，straight 非预乘）。
- **格位由「声明盒」定，不由「当前盒」定**：`autoSize` 会把字段盒改小，而两端改的量不一致（N3）
  ——那是**要看的差异**，不是布局参数。若拿改动后的 `height` 装箱，两端的列切分会跑到不同位置、
  图就对不齐。所以格位高度取「声明盒」（`autoSize` 用例固定回 `100×100`），而**画出来的细框是
  当前盒**——差异正好落在框上。
- **不做像素 diff**：AIR 用自带引擎（SWC 文本还用它内嵌的 SWF 字体），我们走 Skia + 系统字体，
  字形轮廓本来就不该逐像素相同（§0 非目标），像素差恒为「很大」、没有信息量。
- **alpha 统一合成到白底**：AIR 的 `draw()` 是 source-over（透明处保留底色），我们是逐像素覆盖
  （N7），两端 alpha 分布不同；合成后视觉等价。

```sh
AIRSDK_HOME=… sh examples/textfield/run-adl-ui.sh   # -> temp/textfield-oracle-ui/adl.raw
sh examples/textfield/run-aot-ui.sh                  # -> temp/textfield-oracle-ui/aot.raw
python3 examples/textfield/grid.py \
    temp/textfield-oracle-ui/adl.raw temp/textfield-oracle-ui/aot.raw \
    temp/textfield-oracle-ui/grid-cmp.png            # 并排图（另出两张单图）
```

`raw` 头：`TFGRID 1 <W> <H>` + `\n` + `W*H*4` 字节。目录单元回归**不开**这个开关
（`entry-ui.as` 在 `test/examples.ts` 的 `SKIP_FILES` 里）：数值口径不必每次多写一个 4 MB 位图。

---

## 6. 证据与工具索引

| 类别 | 路径 |
|---|---|
| 差异报告（触发） | 工作区根 `talkmed-meeting-aot-vs-adl-diff.md` |
| 本方案的显示矩阵示例 | `examples/textfield/{Main.as,UiMain.as,entry.as,entry-ui.as,app.xml,run-adl.sh,run-aot.sh,run-adl-ui.sh,run-aot-ui.sh,grid.py,README.md}` |
| 双端报告 | `temp/textfield-oracle/{adl,aot}.txt` |
| 双端网格图 | `temp/textfield-oracle-ui/{adl,aot}.raw` → `grid.py` → `grid-cmp.png`（+`-adl/-aot.png` 单图） |
| adl 通用探针 harness | `temp/tryadl.sh <dir>`（`mxmlc` + `adl`，快） |
| 行度量真值台 | `temp/metricprobe/`（12 族矩阵 + leading 矩阵） |
| 富文本真值台 | `temp/ssprobe/`（`StyleSheet`）、`temp/richprobe/`、`temp/pwdhtml/` |
| 字体别名/度量 | `vendor/skia_glue.cc` `sk_family_alias`/`sk_air_line_metrics`、`docs/zh-cn/skia.md` §8 |
| SWC 侧 | `docs/zh-cn/swc.md` §3.3/§9.2 F5、`src/swc.ts` `SwcText`、`src/emit.ts` `as_swc_new` |
| 生成 C 索引（talkmed） | `temp/tkmeet-mac/talkmed.c`：`as_swc_new`@373915、`as_swc_build_87/93`@362987 区、`TextField_ctor`@227037、`as_tf_paragraph`@227103 |

---

## 7. 状态摘要

- **已盘点**：§1 表 16 项能力 ✅、§2 十二项差距（A 包 4 项 + B 包 8 项）+ §2C 八项首次实测新发现。
- **尺子**：两条通道已就位——§5.1 数值报告（逐行 diff，判定依据）+ §5.2 并排网格图（人眼看）。
- **已落地（见 §9）**：T1（空字符串内存安全）、T2a（`DefineEditText` 全量解码 + HTML 实体解码）、
  §2E 的 D-T16/D-T17（`autoSize` 大小口径 + 未安装字族的兜底脸，阶段一百六十八）、
  §2F 的 D-T18/D-T19（字段被缩放时的 `textWidth`/`textHeight` 口径与字形归一化，阶段一百六十九）、
  §2G 的 D-T20（文本子件 `RECT` 原点要走 placement 的线性部分 + twip 栅格，阶段一百七十）、§2C 的 N3。
- **未开始**：T2b（`DefineText` 字形 run）、T3–T6。
- **本轮只登记、未修**：§2G 的 D-T21（`TextFormat` 的「未设字段」语义 + 成员表/构造器不全）——
  单独阶段处理（改的是默认值通路，触及全部文本示例的初始版面）。
- **口径**：一律 `adl 51.4.1` 逐值对齐；不用「看起来差不多」验收。

---

## 8. 首次实测结果（2026-10-14）

工具：`examples/textfield/{Main.as,entry.as,app.xml,run-adl.sh,run-aot.sh,textfield.build.json}`。
两条命令各跑一遍，报告落 `temp/textfield-oracle/{adl,aot}.txt`（**79 例**，183/182 行）。

```
AIRSDK_HOME=… sh examples/textfield/run-adl.sh     # -> adl.txt
sh examples/textfield/run-aot.sh                    # -> aot.txt
```

**总体**：`diff` 报出 **361 个变更行**（共 365 行）——即几乎**每一行**都不同
（其中 N1 的 `align` 一项就让**每一条** case 行不同；把 `align` 归一后仍有 359 行）。
把 `align` 归一后，剩下的系统差异集中在三族：

1. **行高/度量（D-T7/D-T11）**——几乎每例的 `th` 与逐行 `h/asc/desc` 都不同（`_sans` 12：adl `15.5` vs 我们 `12`；`_serif` 12：`15` vs `13`）。
2. **密码掩码（D-T6/N4）**——见上表。
3. **默认值读回（N1/N2/N3）**。

**与 talkmed 视觉差异的对应**：本报告只量**数值**，不含 SWC 静态文本（D-T1/2/3 需 `.swc`）——
那部分另用 `adl` 跑 talkmed 应用对照（见差异报告与环境）。

> 关键结论：**第一优先修的仍然是 D-T7（`_sans`/`_serif` 行高）** ——它不是某个 API 的小偏差，
> 而是**每一行文本**的可观测高度，`th`/`maxScrollV`/`numLines` 可视行数全部随之变化。

### 8.1 第二条通道首次出图（2026-10-14）

工具：`examples/textfield/{UiMain.as,entry-ui.as,run-adl-ui.sh,run-aot-ui.sh,grid.py}`。
两端各产一份 `temp/textfield-oracle-ui/{adl,aot}.raw`（**同为 1240×936** ⇒ 格位逐格对齐），
`grid.py` 拼成 `grid-cmp.png`。图上看得见而报告测不到的：

| 格 | 两端差异（左 adl / 右 AOT） | 对应项 |
|---|---|---|
| `pwd-cjk-only` | adl **1 个星**，我们 **3 个星** | N5 / D-T6（报告中只是 12.00 vs 14.01，图上一眼看出） |
| `embedded-tab` | adl 的 `\t` 明显**更宽**（`a    b` vs `a b`） | D-T11 tab 口径 |
| `font-sans` / `font-typewriter` | 同为 Helvetica / Monaco，但**笔画明显更粗**（光栅器 AA 覆盖率差） | 字形面，§0 非目标 |
| `align-center-ww` / `align-right-ww` | 对齐落点差 ~8px（文字宽度差的下游后果） | D-T7 |
| `auto-left` / `auto-center` | 细框（**当前盒**）大小肉眼可辨（adl 缩到文字高） | N3 |
| 其余（`font-null` / `font-serif` / `border-bg` / `html-font-color` / `range` / `lead0` / `lead8` / `ml-wrap-on`） | **肉眼看不出差别** | — |

> 这张图顺带撞出 N7（`BitmapData.draw` 不同合成）与 N8（`lineStyle(0)` 待查）——两者都不在
> TextField 面上，只登记、不动。

## 9. 已落地（阶段一百四十九，v0.4.120）

按 §4 的顺序推进，第一批落地三项。三项都在 **talkmed 实机**上对 `adl` 验过。

**T1 空字符串内存安全（`emit.ts` ×2 / `runtime.ts`）**

- 契约：`as_str_alloc(n)` 只在 `GCT_STRING` 上分配 `n` 字节、**不清零**，结尾 NUL 由调用者写
  （`runtime.ts` 的 `as_str_alloc` 注释）。四处调用漏写：`TextField_ctor` 的 `o->text` 与
  `Socket__str` 的两条出错路径。
- 修法：新增 `as_str_empty()`（自己写 `s[0] = 0`），四处改调它。**不**在 `as_str_alloc` 里兜底写 NUL：
  那是每字符串一次额外写入的热路径，且会把「忘了写」变成「看不出来」。
- 钉：`test/unit/emit.ts` 的 `unit: emit/EmptyStringTerminator` —— `src/{emit,runtime}.ts` 不得再出现
  裸 `as_str_alloc(1)`、生成的 `TextField_ctor` 必须写 `as_str_empty()`、`Socket__str` 两条出错路径都要。

**T2a `DefineEditText` 全量解码（`swc.ts` + `emit.ts`）**

- `parseSwfText` 逐字段解出 341 个文本字符（338 个 tag 37）的：InitialText / FontID→FontName /
  FontHeight / **RGBA** TextColor / align / margins / indent / leading / Multiline / WordWrap /
  Password / ReadOnly / NoSelect / Border / HTML / MaxLength；新增 `parseSwfFontName`（tag 48/75/91）
  建 `FontID → FontName` 表。
- 两个**格式坑**（都对 skin.swc 实测定案，已写进代码注释）：① flags 是 **MSB-first 的 16 位字**，按 LE
  `UI16` 读会每一位错位（旧代码的 `autoSize` 实际读的是 `HasFontClass`）；② `TextColor` 是 **RGBA 4 字节**
  不是 RGB，少读一字节会让后面的 layout/字符串整体错位。
- `as_swc_new` 的 `'text'` 分支从「建空框」改成「建框 + 盖 InitialText/TextFormat/各标志」。
- `notes` 改为按类分别报告（tag 37 已解码 / tag 11 仍是空框）。`docs/{zh-cn,en}/swc.md` §10-① 同步更新。

**T2c HTML 字符引用解码（`emit.ts`）**

- 新发现：`as_tf_html_set` **完全不解码实体**，talkmed 页脚第二行 `&nbsp;`×8 会原样画出
  （`D-T13`）。新增 `as_tf_html_entity`：命名实体 `&amp; &lt; &gt; &quot; &apos; &nbsp;` + 十进制/十六进制
  数值引用（拒绝代理区）。
- 验：`examples/textfield` 新增三例，`adl` 逐值对齐 —— `html-entity-nbsp` 20.00/20.02、
  `html-entity-named` 55.50/55.51、`html-entity-numeric` 32.00/32.00（差值为已知字形进位残差）。

**实机效果（talkmed → macOS 原生）**：页脚整行及 `meeting.talkmed.com`、修复窗整段说明文字与
「Try to repair」按钮文案、协议段落（`#92`「我已了解并阅读《隐私政策》/《服务协议》」）**首次出现**。
证据图：`temp/cmp/shots/aot_entities_login.png`。

**仍未做**：tag 11（`DefineText`，本库 3 个）字形 run；嵌入字体的字形轮廓（走 Skia 系统字体别名，
度量有残差）；`_sans`/`_serif` 行高（D-T7）；`displayAsPassword` 的 setter 不重排口径（N4）。

## 10. 第二条通道：并排网格图（工具，不占版本号）

口径见 §5.2，实测见 §8.1。新增/改动：

| 文件 | 作用 |
|---|---|
| `examples/textfield/Main.as` | 构造器改成 `Main(ui:Boolean = false)`；ui 模式下把 42 个用例铺成 4 列网格，`BitmapData.draw(this)` + `getPixels()` 写 `textfield-grid.raw` |
| `examples/textfield/UiMain.as` | adl 侧文档类（mxmlc 只能拿无参构造的类当文档类）⇒ `super(true)` |
| `examples/textfield/entry-ui.as` | AOT 侧 ui 入口（`new Main(true)`）；在 `test/examples.ts` 的 `SKIP_FILES` 里 |
| `examples/textfield/run-adl-ui.sh` / `run-aot-ui.sh` | 两端各产一份 `raw`（仍用原 `app.xml`：网格是离屏光栅，不需要窗口） |
| `examples/textfield/grid.py` | `raw` → PNG（alpha 合成到白底）+ 并排拼图 |

不改任何编译器产物（生成 C 与运行时一行未动），因此**不升版本号**；数值回归路径
（`entry.as` ⇒ `new Main()`）也不写位图，目录单元回归的耗时与产物不变。
