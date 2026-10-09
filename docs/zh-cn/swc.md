# SWC 资源提取与嵌入方案

> 本文回答一个问题：**纯 AS 项目把图片等资源打进 SWC，AOT 编译器怎么把这些资源取出来、显示到 UI 上**。
> 核心结论先行：SWC 是 ZIP 归档，但资源**不是 ZIP 里的独立文件**，而是被 mxmlc 编译进 `library.swf`，
> 以 SWF 二进制 tag 形式存放（位图 → `DefineBitsLossless2`/`DefineBitsJPEG2`，经 `SymbolClass` 映射到类名）。
> 因此「解析 SWC 拿资源」= **ZIP 解包 → 解压 SWF → 扫描 tag 流 → 提取位图像素/JPEG 字节**。
> 这条链路在**编译期**（Node 侧，零第三方依赖）完成，把资源转成 C 字节数组嵌入产物；
> 运行时的解码显示复用已有的 Skia 后端（同 `BitmapData.loadFile` 的 `DeferredFromEncodedData` 路径）。
>
> **范围边界（必读）**：`library.swf` 里除资源还有 **255 个 `DoABC`** —— 254 个类的真实 AVM2
> 字节码（54,162 B 纯代码）。本方案**只把 SWC 当资源容器，代码不在范围内**：字节码→可编译产物需
> 反编译器或 AVM2 解释器，那是另一个产品（详见 §3.3）。
>
> **但「代码」对本体量的实际约束很小**（2026-09-26 再审）：实测**唯一**缺源码的是 **`mx.core`/`mx.utils`
> 共 8 个类、3,135 B**（其中 5 个是空接口，真正要写的约 150 行）；其余 240+ 个类要么**有 `.as` 源码**
> （37 个逻辑类 / 32,465 B），要么其「内容」本就是位图/时间轴而非代码（16 个资源类 + 192 个皮肤符号类，
> 类级字节码合计仅 5,641 B 且几乎全是空构造器）。所以本方案**不因「代码」受阻**（详见 §3.3）。
>
> **状态（2026-09-26 复核，v0.3.138）：本文是「方案」文档，尚未实现。**
> `src/swc.ts` 不存在，`src/` 内无任何 `swc` 引用，CLI 无 `--swc`、构建清单无 `swc-paths`
> （全部 10 个清单的 `sources` 里没有一个 `.c`），git 历史无相关提交；`TODO.md` 已将其标注为
> 「调研完成 · 实现暂缓（待用户决定）」。
>
> **本次复核改正了早期版本的七处错误，阅读时请以本页为准**：
> ① 把 `BitmapData.pixels` 说成「RGBA 缓冲」（实为 **straight ARGB**）；
> ② 把 `small_gift`/`checkbom` 算作 16 个位图资源之一（实为 `DefineSprite`）；
> ③ 把嵌入代价低估为「几百 KB 的 JPEG」（实测按早期写定的「原始像素 → `0xNN,` 数组」形态是
> **7.42 MB C 源码**）；
> ④ **漏掉了预乘 alpha**——这是唯一会直接产出可见错误的一条（见 §3.2）；
> ⑤ **漏掉了 SWC 里的一整类内容：代码**——255 个 `DoABC`（254 类 / 54,162 B 字节码）在
> 早期版本的「明确延后」表里都没出现；且类清单只拆到父类层面，把「192 个 `skin_fla/*`」当成一类
> （实测 192 是 `extends MovieClip` 总数，其中只有 89 个叫 `skin_fla.*`），也据此**误判**了源码可得性
> （见 §3.3）；
> ⑥ **嵌入形态选错**：早期版本把 `DefineBitsLossless*` 解成**原始 ARGB** 再以 C 数组嵌入，实测
> 这是 **7.42 MB** 源码；改为嵌入**编码字节**（PNG 重编码 / JPEG 原字节直搬）只需 **42.7 KB**
> （**178×** 差距），且**复用现有解码路径**——`as_skia_image_decode_bytes_argb` **已经存在**，
> 不是「需新增」（见 §5、§7）；
> ⑦ **整类内容遗漏：矢量 shape**——早期版本把「资源」等同于位图，**完全没有处理 `DefineShape`**
> （本文只在 tag 分布表里出现过一次 `DefineShape*×378` 的计数）。实测这类 tag 才是本库资源的**主体**：
> 378 个 shape / 5,052 条边 / 401 个填充样式（含 **73 处位图填充**），且 **43 个 shape 有多个填充**——
> **现有运行时的 `Graphics` 模型（单 `SkPath` + 单 fill + 单 stroke）根本不足以承载**
> （见新增 §3.4、§5.3）。
>
> 本文的技术结论均基于对真实 `temp/skin.swc`（743,520 B，255 个类，59 个位图资源）的**解包实测**，
> 并以 AIR SDK 的 `adl` 取 `getPixel32` 真值交叉验证（方法见 §11）。注意该文件位于
> **仓库根**的 `temp/`，不在 `as3compiler/temp/`。

---

## 1. 为什么这个需求存在：纯 AS 项目里 SWC 是资源载体

在 Flash/Flex 生态里，资源（皮肤位图、图标、字体）有两种归属：

| 场景 | 资源存放 | 提取难度 | 当前编译器状态 |
|------|---------|---------|---------------|
| 自有项目 + `[Embed(source="a.png")]` | 原图还在源码目录 | 低——直接读原图，**不用碰 SWC** | **同样未实现**：`parser.ts` 只做通用元数据解析（`parseMetadataIfPresent`），`Embed` 没有任何语义层消费者；`src/` 内除注释与 `EmbedFont`（app.xml 字体）外无 Embed 处理 |
| 第三方库 / Flash IDE 导出的皮肤库 | 原图不可得，只有 `.swc` | 高——必须解 SWC + 解 SWF | 本方案覆盖 |

用户场景是后者：`temp/skin.swc` 是一个 Flash IDE 导出的 UI 皮肤库（含 `logo`/`imgback`/`desktopicon`/
`cambitmap` 等资源类），原图已丢失，只能从 SWC 里提取。

> 两条路都要写代码，不要把第一行当成「已有捷径」——它的优势仅在**不需要解析 SWF**。

---

## 2. SWC 的解剖：ZIP 外壳 + 内嵌 SWF

把 `.swc` 后缀改成 `.zip` 解压，标准结构只有两个文件（`docs/` 是可选的 ASDoc 文档）：

```
skin.swc (ZIP 归档)
├── catalog.xml     84,463 B（未压缩）/ 5,570 B（deflate 后）—— 组件目录：<script> 列出每个类及其依赖（<dep>）
└── library.swf    737,552 B（未压缩）/ 737,700 B（deflate 后）—— 编译产物：SWF 容器（CWS = zlib 压缩）
```

`catalog.xml` 的结构（实测 `temp/skin.swc`）：

```xml
<swc xmlns="http://www.adobe.com/swccatalog/9">
  <libraries>
    <library path="library.swf">
      <script name="logo" mod="..." signatureChecksum="...">
        <def id="logo" />
        <dep id="flash.display:BitmapData" type="s" />
        <dep id="Object" type="i" />
      </script>
      ...
    </library>
  </libraries>
</swc>
```

**关键事实**：`catalog.xml` 只描述「有哪些类、依赖谁」，**不含资源字节**。真正的图片字节在
`library.swf` 里。文档早期版本把 `catalog.xml` 记作「84 KB」而 `library.swf` 记作「737 KB」，
两者口径其实不同（前者未压缩、后者已压缩），不必对齐。

实测补充：`catalog.xml` 的 `<script>` 条目共 **255** 个；`library.swf` 的 SWF 头部 `version = 44`，
且其 tag 流里有 **255 个 `DoABC`（tag 82）**——这正是「255 个类」的来源（与 `catalog.xml` 一致）。

> `<dep>` 不只是文档：它是一张**现成的依赖图**（哪些类依赖谁、是继承还是实现），本方案在 §3.3.3
> 用它做「引用只以字节码存在的类」的编译期早期诊断。

---

## 3. 资源的真实存放形式：SWF tag

`library.swf` 是标准 SWF 容器，头 8 字节 `CWS` 表示 zlib 压缩（`FWS`=未压缩、`ZWS`=LZMA）。
实测 `temp/skin.swc` 的 `library.swf` 是 **CWS**（解压后 body = 1,031,069 B）。解压后是 tag 流，
每个 tag 由 `(code:length) 头 + 数据体` 组成。

> **重要**：扫描 tag 流前必须先跳过 SWF 的 stage header——`RECT`（`nbits` 以 5 bit 起始，共
> `5+4*nbits` bit）+ `frameRate`(UI16) + `frameCount`(UI16)。实测该文件 `nbits=17`，头部共 **14 字节**。
> 早期实现若从 body 偏移 0 开始扫，会得到一堆无意义的 tag code（很容易误判为「没有位图」）。

资源相关的 tag（实测 tag 类型分布）：

| `[Embed]` 类型 / 资源 | SWF tag | tag code | 数据体内容 |
|---|---|---|---|
| PNG/无损位图 | `DefineBitsLossless` | 20 | SWF 自有位图格式，**无 alpha**（见 §3.1） |
| PNG/无损位图（带 alpha） | `DefineBitsLossless2` | 36 | SWF 自有位图格式，**有 alpha**（见 §3.1） |
| JPEG | `DefineBitsJPEG2` | 21 | `characterID` + **完整 JPEG 字节**（`FF D8` 开头） |
| JPEG（带 alpha） | `DefineBitsJPEG3/4` | 35/90 | JPEG + alpha 数据 |
| 原始字节 | `DefineBinaryData` | 87 | `characterID` + 原始字节 |
| 字体 / 声音 | `DefineFont*` / `DefineSound` | 10/48/14/75 | 字体/音频数据 |
| **symbol → 类名** | `SymbolClass` | 76 | `{id → "类名"}` 映射 |
| 时间轴影片剪辑 | `DefineSprite` | 39 | 显示树（`PlaceObject` 子对象） |

实测 `temp/skin.swc` 的 `library.swf` 有 **59 个位图 tag**（`DefineBitsLossless2`×53 +
`DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2），`SymbolClass` 里 **214 条映射**；
另有 `DefineSprite`×333、`DefineShape*`×378、`DefineButton2`×29、**`DefineFont3`×7**。

### 3.1 重要陷阱：`DefineBitsLossless` 存的**不是 PNG**，且 tag 20 与 tag 36 语义不同

这是最容易踩的坑。`DefineBitsLossless2` 的数据体**不是** PNG 文件，而是 SWF 自定义的位图格式：

```
DefineBitsLossless2 (tag 36) 数据体：
  characterID   u16   （symbol id）
  bitmapFormat  u8    （3 = 8bit 带色表；4 = 15bit RGB；5 = 32bit **ARGB（含 alpha，预乘）**）
  width         u16
  height        u16
  [colorTableSize u8]  （仅 bitmapFormat==3；实际色表项数 = 该值 + 1）
  zlibData      ...   （zlib 压缩的像素数据）
```

实测提取 `symbol#2`（`logo`）：`characterID=2, format=5, 100×72`，解压后像素
`28800 字节 = 100×72×4`，前 16 字节全 0（透明边缘），非零像素占 37.1%——是有效图片内容。

**tag 20 与 tag 36 不能混为一谈**：两者数据体布局几乎相同，但 **tag 20 的 format 5 是 24-bit RGB
（XRGB，第 1 字节是填充位，没有 alpha 语义）**，而 tag 36 的 format 5 才是真正的 ARGB。
把 tag 20 的第 1 字节当 alpha 用，在填充位为 `0x00` 的产物上会整张变全透明。实测
`temp/skin.swc` 里唯一一个 tag 20 恰好是**最大的资源** `cambitmap`（700×393，1,100,400 B 像素，
填充位恰为 `0xFF`，所以碰巧能显示正确——这种「碰巧」正是要避免的）。

**结论**：`DefineBitsLossless*` 需要「解 zlib → 得到原始像素」，**不能**直接喂 Skia 的
`MakeFromEncoded`（它只认 PNG/JPEG 等编码格式）。而 `DefineBitsJPEG2` 存的**就是完整 JPEG**，
可直接喂 Skia。

### 3.2 像素格式契约（本节为 2026-09-26 复核新增，是唯一会导致可见错误的遗漏）

原始位图的像素有两条必须先讲清的性质：**字节序**与**是否预乘**。两条都已用 `adl` 取真值定案。

**① 字节序 = `A, R, G, B`（第 1 字节是 alpha）**——7200/7200 像素逐一验证：我们解析出的
`px[0]` 与 `logo.getPixel32()` 的 alpha 通道**完全相等**，无一例外。

**② 数据是「预乘（premultiplied）ARGB」，而 AIR 的 `getPixel32` 返回的是「直通（straight）ARGB」。**

验证方法与结果：

- **受控实验**（自造已知直通值的 PNG，经 `mxmlc` 编译后同时看两端）：
  写入 `R=200, G=100, B=50, A=4` 的像素，AIR 读回 `A=4, R=191, G=64, B=0`。
  若存储是直通，读回应为 200/100/50；实际读回的是「把极小的预乘值放大回来」的结果
  （`R_pm≈3` → `3×255/4=191.25`），且 **`B` 被彻底丢失（50→0）**——因为 `50×4/255<1` 被截断。
- **统计验证**：SWC 内 `logo` 全帧 7200 像素中，**`R|G|B > alpha` 的像素为 0**、
  **alpha=0 但 RGB 非零的像素为 0**——这正是预乘数据的签名（直通数据几乎不可能同时满足两条）。
- **AIR 反预乘的精确规律**（用 `logo`+`imgback`+`desktopicon` 共 340,644 个通道样本、
  219 种 `(alpha, 存储值)` 组合反解）：`(alpha, 存储值) → AIR 值` 是**纯函数**（219 种组合 0 冲突），
  且等于 `floor(存储值 × 255 / alpha + t)`，`t ∈ [0.329, 0.413)`。
  **`floor(x + 1/3)` 在全部 219 种组合上 219/219 精确命中**；与最常见的 `round(c*255/a)` 相比，
  最大偏差仅 **−1**（2/219 组例外，其余 217 组完全一致）。

**这意味着什么**：本方案的运行时缓冲是 **straight ARGB（`0xAARRGGBB`）**，
与 AS3 的 `BitmapData` 契约一致（见 §5、§7）。因此**「解出的 ARGB 像素直接填 `BitmapData.pixels`」
是错的**——会得到整体偏暗的结果，alpha 越低错得越离谱：

| 场景 | 存储值 | 直接填（错） | 反预乘后（正确 = AIR） |
|---|---|---|---|
| `logo` 的 A=31 像素 | R=24 | 24（暗 87%） | **197** |
| 受控实验 A=4 像素 | R=3, G=1, B=0 | 3 / 1 / 0 | **191 / 64 / 0** |

**正确做法**：反预乘**在编译期做**（`swc.ts` 提取时即转换），把嵌入的字节直接变成 straight ARGB，
运行时零开销。参考实现：

```c
/* 编译期（Node 侧）：stored 预乘 ARGB -> straight ARGB。
   t 取 1/3 是实测拟合 AIR 的取值（阈值带 [0.329, 0.413)），与 AIR 逐像素一致。 */
static uint8_t out = a == 0 ? 0 : min(255, (int)floor(c * 255.0 / a + 1.0 / 3.0));
```

> **不要**反过来做（运行时解码时反预乘）：那会污染每个资源类实例的构造路径，且与
> `BitmapData.loadFile` 的「Skia 已经给 straight 像素」路径不一致。编译期做既省运行时开销，
> 又让嵌入的字节与 `getPixel32` 的返回值语义统一。

> 若将来不愿依赖 `t=1/3` 这一拟合值，退一步用 `round(c*255/a)` 亦可——与 AIR 的差异是
> ±1 个通道级（视觉不可辨）；但**绝不能不反预乘**。

### 3.3 另一类 tag：代码（`DoABC` / ABC 字节码）——**这是范围声明，不是「延后」**

`library.swf` 里除了位图资源，还有 **255 个 `DoABC`（tag 82）**，它们是 **254 个类的真实 AVM2
字节码**，不是空壳占位。实测（自写解析器对 **255/255** 模块 round-trip 精确吻合，方法见 §11）：

| 指标 | 实测 |
|---|---|
| `DoABC` 模块 | **255** |
| ABC 容器总量 | **252,737 B** |
| 类 / 方法 / 方法体 | **254 / 1429 / 1316** |
| **纯字节码** | **54,162 B**（占 ABC 的 21%，其余是常量池与元数据） |
| 字符串常量 | **9,977**（实体数；含保留槽 0 的原始计数为 10,232） |
| 最大单个方法体 | 2,234 B |

内容是真逻辑，不是符号占位（按单模块字节码排序）：

| 模块 | 字节码 | 备注 |
|---|---|---|
| `com/vsdevelop/utils/StringCore` | 4,373 B | 自家工具库（最大） |
| `com/vsdevelop/air/download/DownLoader` | 3,576 B | 自家下载器 |
| `com/greensock/TweenLite` | 2,799 B | Greensock 缓动库 |
| `com/adobe/crypto/MD5` | 2,616 B | AS3 加密 |
| `mx/core/BitmapAsset` | 2,515 B | Flex 框架 |
| `com/adobe/serialization/json/JSONTokenizer` | 2,480 B | JSON 解析器 |
| `com/vsdevelop/controls/scrollbar/MWIOSScrollBar` | 2,195 B | 滚动条组件 |
| `com/vsdevelop/controls/ComBoBox` | 1,557 B | 下拉组件 |

#### 3.3.0 254 个类的完整拆分（含**源码可得性**，这是决定本方案可行性的真数据）

早期版本只拆到父类层面，并据此得出「约 240 个类无源可编译」的错误结论。按**互斥**划分重算（类级字节码 = 只统计挂在实例/类 trait 上的方法）：

| 类别 | 数量 | 类级字节码 | 内容 | 源码可得性 |
|---|---|---|---|---|
| 位图资源类（`extends BitmapData`×4 / `BitmapAsset`×12） | 16 | **152 B** | 内容=位图，类只是 9–11 B 构造器 | 需从 SWC 合成（§5） |
| `extends MovieClip` 的 Flash IDE 符号类 | **192** | **5,489 B** | UI 皮肤元件（`alertskin`/`popgiftskin`/`homeskin`…）；**绝大多数是 9 B 空构造器**，仅少数有真代码（`checkbom` 132 B、`toastbtn` 73 B、`devicesitemskin` 62 B、`PPTNextPage(Pre)Button` 51 B） | 代码可忽略；**内容**是时间轴/位图 |
| 接口（`extends null`） | 6 | 6 B | 空 | — |
| `mx.core` / `mx.utils`（Flex） | **8**（其中 5 个就是上行的接口） | **3,135 B** | 见下 | **无源码（唯一一组）** |
| 其余逻辑类 | 37 | **32,465 B** | `TweenLite`/`MD5`/JSON/`StringCore`/`DownLoader`/`X MLLoader`/滚动条组件… | **有 `.as` 源码** |
| **合计** | **254** | **41,242 B** | | |

> **统计口径**：类级字节码只覆盖「挂到类/实例 trait 上的方法」；余下 **12,920 B** 属于模块级
> `script_info` 初始化与未挂 trait 的嵌套函数，两者相加 = **54,162 B** 总量（见 §11）。

> **修正两处早期说法**：① 「192 个 Flash IDE 导出的 `skin_fla/*`」不准——192 是 `extends MovieClip`
> 的**总数**，其中只有 **89 个**名字是 `skin_fla.*`，另 **103 个**是平名皮肤类（`alertskin`、
> `popgiftskin`、`checkbom`…）；② 字符串常量的**实体数**是 **9,977**，`10,232` 是含保留槽 0 的原始计数。

**`mx`/`flex` 是唯一「无源码」的一组，而且量极小**：

| 类 | 字节码 | 形态 |
|---|---|---|
| `mx.core.BitmapAsset` | 2,464 B | 薄包装：`extends mx.core.FlexBitmap`，持有 `bitmapData`/`smoothing` |
| `mx.utils.NameUtil` | 566 B | 工具函数 |
| `mx.core.FlexBitmap` | 100 B | `extends flash.display.Bitmap` |
| `mx.core.IFlexDisplayObject` / `IAssetLayoutFeatures` / `IRepeaterClient` / `ILayoutDirectionElement` / `IFlexAsset` | 各 1 B | 空接口 |

即：**手写约 3 KB 字节码对应的 AS3（≈150 行）就能补齐全部「无源码」缺口**。注意
`mx.core.BitmapAsset` 是 **12 个 `ScrollSkin_*` 资源类的父类**，所以它必须有实现。

**结论（范围声明）**：现实默认形态 =「**资源取自 SWC，代码来自 `.as` 源码**」。这条约束的实际代价
很小：实测只有 **mx/flex 这 8 个类（3,135 B）** 缺源码，且其中 5 个是空接口；其余 240+ 个类要么有源码
（37 个逻辑类 / 32,465 B），要么其「内容」是位图/时间轴而非代码（16 + 192 = 208 个类，类级字节码
合计仅 5,641 B）。**早期版本把 `TweenLite`/JSON 解析器/`DownLoader` 等也列为「无源可编译」是错的**
（它们有源码），照原文读会让人以为本方案被「代码」卡死。

#### 3.3.1 读容器：已解，是封闭的小问题（约 400 行）

`DoABC`(tag 82) 的数据体**不是** ABC 本体，而是 `u32 flags` + **空结尾 cstring 名**（模块名，如
`com/greensock/TweenLite`）+ ABC。ABC 按固定段序解析，但有四个必须记牢的语义坑（实现时逐一踩过，
参照 Ruffle `swf/src/avm2/read.rs::read_trait` 定案）：

| 段 | 语义 |
|---|---|
| 池类（int/uint/double/string/ns/nsset/multiname） | 计数**含保留槽 0**（实体数 = `count-1`） |
| method / class / script / method_body / metadata | 计数是**精确值**（**无**保留槽） |
| `instance_info` | 仅当 `flags & 0x08`（`CONSTANT_ClassProtectedNs`）才多一个 `protectedNS: u30` |
| `trait_info` | `kind` 字节**低 4 位 = trait 类型**（0 Slot/1 Method/2 Getter/3 Setter/4 Class/5 Function/6 Const），**高 4 位 = 属性**（`0x10` Final / `0x20` Override / `0x40` Metadata）；**metadata 表位于 kind 载荷之后，不是之前** |

（另三处细节同样会静默错位：
① `method_info` 的 `HAS_OPTIONAL` 项是 `value u30 + kind u8` **两项**；`HAS_PARAM_NAMES` 读 `param_count` 个名字；
② **`class_info` 向量没有计数前缀**——它的长度就是 `instance_count`（Ruffle: `read_vec(instances.len(), read_class)`），
多读一个 u30 会全盘错位；
③ **池类索引 0 是保留槽**，查名字时必须取 `pool[idx-1]`（否则会得到一堆乱名字，但**不会**报错）。
另外 `trait_info` 的 kind 4（`Class`）第二个字段是**类索引**而非方法索引，别拿它去查方法体。）

按此实现的解析器对 **255/255** 模块**精确消耗到最后一个字节**——即 round-trip 自证正确，不是
「看着像对」。所以**容器读取是约 400 行、可完全测试的活**，若将来要做，这一步不难。

#### 3.3.2 读代码：五条路，其中**只有 D + E** 在本方案的航向上

方法体是 **AVM2 栈式字节码**，不是源码。要真正「用起来」只有下列几条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 反编译 → AS3 源码 | 字节码 → 源码 → 喂给现有前端 | 栈→表达式、控制流重建、异常表→try/catch；研究级（JPEXS / rabcdasm 量级），保真度差，产出仍需人肉修 |
| B. ABC → 我们的 AST（跳过文本） | 直接建 `ast.ts` 节点 | 仍需栈→表达式与作用域/闭包语义，等于**再写一个前端**；还要覆盖我们未实现的 AVM2 trait/slot 分派 |
| C. 内嵌 AVM2 解释器 | 直接运行字节码 | 与 AGENTS.md §1「翻译成可读 C」**方向相反**，是另一个产品 |
| **D. 不解析代码** | SWC 只当资源容器，代码来自 `.as` | **本方案的定位**（§7 的 `src/swc.ts` 只做资源提取） |
| **E. 手写那几个类** | 对「无源码」的类直接手写等价 `.as` | **对 mx/flex 这 8 个类（3,135 B）是现实选择**：其中 5 个是空接口，真正要写的只有 `mx.core.BitmapAsset` / `FlexBitmap` / `NameUtil` 三个薄包装，**约 150 行**（见 §3.3.0） |

> 因为实测**只有** mx/flex 缺源码（§3.3.0），所以现实中最自然的组合是 **D + E**（其余全走源码，
> 那几个类手写），而**不需要** A/B/C 任何一条。

**所以范围写死**：本方案**不含**「字节码 → C」的翻译；若将来要支持只以 ABC 存在的类，须**另行立项**
（反编译器或 AVM2 解释器），而非在本方案里加一个子任务。

#### 3.3.3 用 `catalog.xml` 的 `<dep>` 做编译期早期诊断（**建议随首期一起做**）

`catalog.xml` 的每条 `<script>` 已经列了该类的定义与依赖及类型（`<dep id="flash.display:BitmapData"
type="s"/>`，`s`=继承/`i`=实现）—— **这是一张现成的依赖图，读它不需要解析任何 ABC**。

用它把「引用了只以字节码存在于 SWC 的类」从**运行期静默失败**变成**编译期明确报错**：

```
error: class 'mx.core.BitmapAsset' is only available as AVM2 bytecode inside
       'skin.swc' (2,464 B of ABC, not translatable); provide its .as source
       or a source-compatible replacement.
```

> 注意例子里用的是 **mx 类**而不是 `TweenLite`：实测**只有** mx/flex 这 8 个类真正缺源码
> （§3.3.0），而 `TweenLite`/`MD5`/JSON 都是**有源码**的。诊断器应该做的是「SWC-only 且无 `.as` 源」
> 的交集，而不是把所有 SWC 内的字节码类都报一遍（后者会误报一大片有源码的类）。

做法是名字层面的集合运算（`catalog.xml` 的类名集合 ∩ 前端符号表 ∩ 「无 `.as` 源」）→ 命中即报错，
**不反编译任何东西**。成本极小、价值很高：否则用户拿到的是「编译通过、运行期 undefined」这类最难查的失败。

---

### 3.4 另一类 tag：矢量 shape（`DefineShape`）——**本库资源的主体，早期版本整类遗漏**

早期版本把「资源」等同于位图，`DefineShape*×378` 只在 §3 的 tag 分布表里出现过一次计数，
**既无章节也无方案**。实测这类 tag 才是本库资源的**主体**（且矢量正是 Flash 的核心能力）。

**① 实测 tag 画像**（递归扫进 `DefineSprite`；`temp/skin.swc`）：

| tag | 数量 | 说明 |
|---|---|---|
| `DefineShape`/`2`/`3`/`4` (2/22/32/83) | 186 / 50 / 56 / 86 = **378** | 矢量 shape，payload 合计 **29,774 B** |
| `DefineSprite` (39) | 333 | 皮肤符号的时间轴容器 |
| `PlaceObject`(1) / `PlaceObject2`(26) / `PlaceObject3`(70) | 1,479 / 1,935 / 64 | 时间轴摆放记录 |
| `DefineScalingGrid` (78) | 22 | **九宫格缩放**（`scale9Grid`），皮肤拉伸要按它切 |
| `DefineButton2` (34) | 29 | 按钮四态 |
| `DefineMorphShape`/`2` (46/84) | 4 / 2 | 形变 shape |
| `DefineEditText`(37) / `DefineText`/`2`(11/33) | 337 / 3 | 文本字段（走既有 `TextField`，不属矢量域） |
| `DefineFont3` (75) | 7 | SWC 内嵌字体（§10 已列） |

**② shape 的几何与样式实测**：

| 项 | 实测值 |
|---|---|
| 版本分布 | v1 186 / v2 50 / v3 56 / v4 86 |
| 边总数 | **5,052**（直线 3,059 / **二次贝塞尔 1,993**） |
| 子路径（`moveTo`）/ 样式切换 | 905 / 998 |
| 填充样式 401 | 实色 326、**位图 73**、线性渐变 2、径向/焦点 **0** |
| 描边（`LineStyle`） | 86 条；**80 个 shape 有描边**；**43 个 shape 有多个填充** |
| 被引用的位图 | **39 张不同位图**作为填充 |
| v4 `UsesFillWindingRule` | **无 shape 使用**（即无 even-odd 填充规则） |
| 最大 shape | 284×432 px |
| 建路径调用 | 边 5,052 + `moveTo` 905 = **5,957** → 约 **233 KB C**（@40 B/调用） |

**③ shape 不是独立符号，必须连同显示树一起处理**：

| 项 | 实测 |
|---|---|
| `SymbolClass` 214 条 | **196 个是 `MovieClip` sprite**、16 位图、2 按钮；**没有任何 shape 直接导出为类（0/378）** |
| 导出符号闭包 | 需要 **322 shapes / 327 sprites / 16 bitmaps / 337 edittext**；4,181 条边 → 约 **194 KB C** |
| 引用图自证 | 978/978 个被摆放的字符 id 全部命中已知字符 |

**④ 格式要点（实现必读，对齐 Ruffle `read_define_shape`）**：

- `SHAPEWITHSTYLE` = `FillStyleArray` + `LineStyleArray` + `NumFillBits`/`NumLineBits`（各 4 bit）
  + **shape records（连续位流）**；`NEW_STYLES` 记录会在中途**重定义样式表**（并 byte-align）。
- 边只有两种：**直线**与**二次贝塞尔** → 直接映射 `SkPath::lineTo` / `quadTo`（无三次、无圆弧）。
- **每条子路径各自带 `fill0` / `fill1` / `line` 索引** → 必须**逐子路径**分别建路径、分别绘制，
  不能合并成一条 path 一次画（本库 43 个 shape 有多个填充）。

**⑤ 两个位序坑（实测，最易静默错位）**：

- **`LINESTYLE2`（仅 shape v4）的 flags 是 MSB-first 位流**：`JoinStyle` 落在 bit13–12
  （`JoinStyle==2` 即 miter）。若按小端 `u16` 读，字段顺序会颠倒 → 该 shape 的后续全部漂移
  （实测 v4 中有 5 个 shape 因此解析失败）。判据：`MiterLimitFactor` 的 `FIXED8` 常见值
  **4.0 = `0x0400`**，读错时这个值会变成 0.0156 这种不可能的数。
- **`PlaceObject2` 的 flags 是 LSB-first**（与上一条相反）：`HasCharacter = 0x02`。
  另注意每个 `DefineSprite` 末尾都有一个**长度为 0 的 `PlaceObject`（字节 `40 00`）**，
  不加长度护栏会读出 `id=0` 的垃圾引用（实测污染 336 条引用）。
- **自证判据与 ABC 相同**：解析器必须**精确消耗到 tag 末尾**——本库 **378/378** 全中才认为段序正确。

**⑥ 与位图方案的关系**：73 处位图填充引用的正是那 59 个位图 tag 中的 39 张——**矢量与位图是同一条
通道的两半，不能只做一半**。运行时侧的缺口与体积量级见 §5.3。

---

## 4. 编译期提取链路（已端到端复验）

```
SWC (ZIP)
  │  ① 手写 ZIP central directory 解析（Node 侧，零依赖）
  ▼
library.swf (deflate 压缩的 CWS 文件)
  │  ② zlib raw-inflate 解 ZIP 层 → 得到 CWS 文件字节
  ▼
CWS 文件（"CWS" + version + fileLength + zlib 流）
  │  ③ zlib inflate 解 CWS 层 → 得到 SWF body
  ▼
SWF body（跳过 stage header：RECT + frameRate + frameCount）
  │  ④ 逐 tag 扫描，命中 DefineBitsLossless2(36)/Lossless(20)/JPEG2(21)/JPEG3(35)
  ▼
位图资源：
  ├─ Lossless2/Lossless → zlib 解压 → 原始**预乘**像素（+ 宽高）
  │                         ├─→ 反预乘 → straight ARGB（§3.2，编译期）
  │                         └─→ **PNG 重编码**（§5.1，约 100 行编码器）→ 编码字节
  └─ JPEG2/3   → 完整 JPEG 字节（+ alpha）——**原字节直搬，零转换**

两者统一交给运行时现成接口（§5）：as_skia_image_decode_bytes_argb → straight ARGB → BitmapData
```

**复验结果**（真实 `skin.swc`，2026-09-26 重跑）：

```
① ZIP 层 deflate 解压: 737,700 B → CWS 737,552 B
② CWS 层 zlib 解压:    → SWF body 1,031,069 B
③ stage header 跳过:   nbits=17 → 14 字节
④ tag 总数 1,504，位图 tag 59（36×53, 20×1, 21×3, 35×2），SymbolClass 214 条映射
⑤ Lossless2 提取:      characterID=2, format=5, 100×72, 28,800 B 像素
⑥ 有效内容 37.1% 非零；逐点与 adl 的 getPixel32 对齐（§3.2）——提取正确
```

**零第三方依赖的可行性**：ZIP 的 central directory 结构（`PK\x01\x02` 头 + `PK\x05\x06` EOCD 尾）
手写解析约 30 行；zlib 解压用 Node 内置 `zlib.inflateSync`/`inflateRawSync`；SWF tag 扫描约 40 行。
全部在编译前端（Node 侧）完成，符合 AGENTS.md §3.1「零第三方依赖」。

**`ZWS`（LZMA）的确切布局**（早期版本只说「需 mangled header 处理」，未给方法；现已实测解出）：

```
'ZWS' + version(1) + fileLength(4, = 解压后总长)
  + compressedLength(4)          ← 注意：这一层 4 字节长度字段很容易被漏掉
  + lzmaProps(5)                 ← props[0] → lc/lp/pb；实测 lc=3, lp=0, pb=2
  + LZMA1 raw 流                 ← dict 由 props[1..4] 给出（实测 0x200000 = 2 MB），
                                    解压长度未知（用 SWF 头部的 fileLength 校验）
```

即用「LZMA raw filter + 从 props 还原的 lc/lp/pb/dict」即可解，无需 `make_lzma_reader` 之类的
mangled-header 补丁（那是给 LZMA-alone 13 字节头用的）。`temp/skin.swc` 是 `CWS`，此路径首期可不做，
但既然布局已定，实现成本很低。

---

## 5. 资源 → 产物：内嵌**编码字节**（本节结论已按实测改写）

用户已确定**编译期提取、编译期嵌入**（AIR 的资源类构造器是**同步**的，不能改成运行时异步加载）。
但嵌入的**内容形态**早期选错了：早期版本把 `DefineBitsLossless*` 解成**原始 ARGB** 再以 C 数组打进产物。
实测这是源码体积的最大浪费源（见 §5.1），应改为**嵌入编码字节**：

| 资源格式 | 嵌入内容（**编码字节**） | 运行时解码 |
|---------|----------------------|-----------|
| `DefineBitsJPEG2/3` (21/35) | **JPEG 原始字节直搬**（零转换） | 现有 `as_skia_image_decode_bytes_argb` |
| `DefineBitsLossless2` (36) | 编译期做**反预乘**（§3.2）后**重编码为 PNG** | 同上 |
| `DefineBitsLossless` (20) | 同上，但源数据无 alpha → 写 `A=0xFF` | 同上 |

**为什么这是等价的、而且更好**：

- **零新运行时代码**。所需的 API **已经存在**——`as_skia_image_decode_bytes_argb(data, len, &w, &h)`
  （`runtime.ts`；非 Skia 构建有同名桩）内部就是 `SkData::MakeWithCopy` →
  `SkImages::DeferredFromEncodedData` → `readPixels(kBGRA_8888, kUnpremul)` → `sk_bgra_readback_to_argb`，
  **直接产出 straight ARGB**。`emit.ts` 已在 `Loader.loadBytes` 路径上用它。
- **保真**。PNG 无损，且「预乘后取整」的信息损失发生在**编译期**、由我们控制：写进 PNG 的正
  是 §3.2 算出的 AIR 读回值。

  > **实测修正（2026-10-05，阶段九十五实施期）**：早期版本在此写「运行时解码拿到的就是同一组
  > straight ARGB，`getPixel32` **逐点对齐**」——这句话**过强，已按实测改写**。分两段核验：
  >
  > 1. **我们写出的 PNG 是逐点精确的**：用纯解码器（zlib inflate + filter 0，不经 Skia）解开
  >    `encodePng` 的输出，与 `adl` 的 `getPixel32` 真值比对，**322,300 像素 maxChannelDiff=0**
  >    （logo/imgback/cambitmap）。编译期提取与反预乘**没有任何偏差**。
  > 2. **偏差来自 Skia 的运行时解码，且只在半透明像素上出现**：`readPixels(kBGRA_8888,
  >    kUnpremul)` 对一张 straight-alpha PNG 并不做「直通」——Skia 内部先 `SkMulDiv255Round`
  >    预乘、再按 `(v*255 + a/2)/a` 反预乘，两次取整让结果漂 ±1。实测 AOT 产物 vs `adl`：
  >    **388,648 像素中 206 个不符（0.053%），全部 maxChannelDiff=1，且只落在 `logo` 的
  >    A∈{143,191} 半透明像素上**（imgback / desktopicon / cambitmap 三张 0 偏差——它们的
  >    alpha 只有 0 或 255，两次取整都是恒等）。
  >
  > 结论：这与 §11 验收③「允许 ±1 通道偏差」一致；**alpha 通道逐位精确**，视觉不可辨。
  > 这是 Skia 库边界行为，不是我们的实现缺陷；要彻底消除需在生成 C 里自带 PNG 解码器
  > （zlib inflate + unfilter）绕开 Skia 的 alpha 变换，代价与收益不成比例，**不做**（§10 记为已知限制）。
- **体积**：见 §5.1，**178×** 的源码体积差。

> **注意「缓冲格式」**：`BitmapData.pixels` 是 **`uint32` 数组，存 straight ARGB 数值
> `0xAARRGGBB`**（`runtime.ts` 的 `sk_surface_read_argb` 注释即如此声明；`getPixel32`/`setPixel32`/
> `threshold`/`colorTransform`/`copyChannel`/`merge`/`paletteMap`/`floodFill` 及 `(c>>16)&0xFF`
> 惯例全部依赖该契约）。早期版本把它记作「RGBA 缓冲」是错的——在小端机器上该数值的**内存字节**
> 才是 `B,G,R,A`，这与 Metal 的 `BGRA8Unorm` 天然一致，**但数值语义始终是 ARGB**。
> （即：我们**从不**直接往 `pixels` 里按字节写；总是走 Skia 解码拿 straight ARGB 数值，
> 与主机端序无关。）

> **`as_skia_image_from_bytes` 不需要新增**：早期版本把它列为「拟新增 / 当前尚不存在」，实测该能力
> 已由 `as_skia_image_decode_bytes_argb` 提供（见 §7）。glue 侧现在用的是
> `SkImages::DeferredFromEncodedData`（不是早期版本写的 `MakeFromEncoded`）。

### 5.1 嵌入形态与源码体积代价（**三种形态逐项实测**，早期估计已修正）

对 `temp/skin.swc` 的 **16 个命名资源**逐项实测：

| 形态 | 合计 | 说明 |
|---|---|---|
| SWC 内的压缩字节（tag payload） | **13,097 B** | fmt5 是 zlib 压缩的**预乘** ARGB |
| 解成原始 ARGB | **1,555,412 B** | 早期方案打算嵌入的东西 |
| **重编码为 PNG** | **14,569 B** | 只比 tag payload 大 11% |
| PNG 嵌入 C 源码（`\xNN` 转义字符串） | **43,723 B ≈ 42.7 KB** | **应采用的形态** |
| 原始 ARGB 嵌入 C 源码（`0xNN,`） | **7,777,060 B ≈ 7.42 MB** | **早期方案，错** |

单看最大的 `cambitmap`（700×393，tag 20）：原始 ARGB **1,100,400 B** → PNG **8,070 B**。

**源码体积差 178×**。所以资源段应长这样（编码字节，不是像素）：

```c
/* SWC resource: skin.swc#logo (100x72) — PNG bytes; decoded at runtime by
   as_skia_image_decode_bytes_argb (same path as Loader.loadBytes). */
static const unsigned char __res_skin_logo_png[] =
  "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR...";   /* PNG 总计 1,651 B */
static const int __res_skin_logo_w = 100;
static const int __res_skin_logo_h = 72;
```

**与阶段七十八已不再冲突**：资源合计约 **42.7 KB C 源码**（相对 `hello.as` 的 854 KB 是 5%），
完全可以在**单个 `.c`** 内嵌，与「单文件 `.c` 是默认形态」一致。早期版本因选了原始像素形态，
才被迫写下「资源段**必须**独立 `.c`」——**那条强制项随本节结论一并取消**：

- **默认**：资源字节内嵌进同一个 `.c`（实测规模下无必要拆分）。
- **例外**：若某个 SWC 的资源总量使单一 `.c` 超过实现者设定的阈值（例如 >5 MB 源码），
  再降级为「资源段独立 `.c` + 构建清单 `sources` 合并」——构建层已支持（AGENTS.md §2.9）。
- 两种形态下 `-O2` 都会丢弃未被引用的资源段，不影响最终二进制体积。

  > **实测修正（2026-10-05，实施期）**：前半句**成立但须限定**。native `-O2` 下拿 `hello.as`（完全不引用任何资源）
  > 与加上 `--swc temp/skin.swc` 比：二进制 **130,552 → 195,880 B（+約 65 KB）**，其中 `__text` 59,012 → 99,556
  > （**+40.5 KB 代码**）、`__data` 4,088 → 17,384（**+13.3 KB 表格**）。**嵌入的 PNG 字节本身确实被丢掉**
  > （在产物里搜不到任何一张资源的完整字节），但**合成出来的 16 个资源类并不被裁**——它们的构造器/`_new`/虚表/
  > props 表/注册表项互相引用成一簇，链接器从可达根出发删不掉（且这是 **§6 要的语义**：`getDefinitionByName("logo")`
  > 必须随时能解析）。所以准确说法是：**未引用的资源“字节”会被丢弃，但资源“类”的开销会留在产物里**
  > （16 类约 53 KB / 即 ≈3.3 KB 每类）。引用到某个资源时，其字节才真正进入产物。

> **编译期需要一个 PNG 编码器**：Node 内置 `zlib` 即可实现（IHDR/IDAT/IEND + 每行 filter 0，
> 约 100 行，零第三方依赖）。`DefineBitsJPEG2/3` 的 tag 本来就存着完整 JPEG，**原字节直搬、无需编码器**。
> 实测本样本的 16 个命名资源全为 lossless（无 JPEG 命中），故首期必须实现 PNG 编码器。

### 5.2 不该内嵌的资源：桌面 / web / 移动三端的资源通道（**已存在，勿另造**）

「资源」不止 SWC 里那些编译期已知的位图类。大图、音频、字体、外部数据**不应**编进 `.c`——
它们需要懒加载，而且 web 首屏不该背一个巨大的 `.wasm`。好消息是这条通道**已经实现且已按平台分派**：

| 平台 | 现有机制 | 代码位置 |
|---|---|---|
| 桌面 native | 可执行文件以 **CWD = app 目录**运行，`File.applicationDirectory` 解析到该目录 → 资源就是**普通文件**（`assets/...` 放在旁边），与 `adl` 的安装目录语义一致 | `air-app.ts` |
| web（wasm） | 浏览器沙箱 FS 是空的 → `--package web` 时 `findPreloadPaths()` 把 app 目录下（排除 `src/`、`<filename>*` 产物前缀、dotfile）的条目交给 **`--preload-file <root>@<dest>`** 打成 packed FS（+ `-s FORCE_FILESYSTEM=1`），于是**同一份 `assets/...` 路径**在浏览器里也能读 | `build.ts`（`preloadPaths`）、`air-app.ts::findPreloadPaths` |
| macOS / iOS（`.app`） | `--package xcode-project` 生成 application bundle，资源走 **PBXResourcesBuildPhase**（目前实现了 `icon`；字体经 `font-urls`） | `xcode-project.ts`、`pbxproj.ts` |
| **字体（现成先例）** | `<embedFonts><font><fontPath>` → 清单 `font-urls` → **web 上运行时 fetch 后注入 Skia 字体管理器** | `air-app.ts`、`html5-web.md §3` |

> **平台成熟度（同次实测）**：`--package xcode-project` **目前只支持 macOS**（`--target` 非 native 会显式报错，
iOS 需另立项）；`--package android-project` 直接报 `not yet implemented`。所以「三端」目前实际可用的是
> **桌面 + web**，`.app` 只到 macOS。

**因此资源应分两层**（这是本节要写死的设计决定）：

1. **可运行时加载的**（大图、音频、字体、外部数据）→ 走**文件 + preload/Resources 通道**（上表）。
   三端天然适配，web 还能懒加载。
2. **编译期符号化的**（`new logo()`、`new ScrollSkin_topSkinClass()`）→ 必须**内嵌**（§5.1），
   因为 AIR 的资源类构造器是**同步**的。

> **一个必须显式写下的例外**：第 2 类**不能**退化成「首次访问时从磁盘懒加载」——那会把
> `new logo()` 从同步变成需要泵一帧，属于**改语义**。宁可内嵌（实测只有 42.7 KB）。

---

### 5.3 矢量 shape：同样是「编译期烘焙」，但运行时缺口在 `Graphics` 模型

矢量与位图**共用同一条通道**（§3.4⑥），但落地形态不同：位图只需嵌入编码字节 + 复用解码；
shape 要**在编译期翻译成「构建 `SkPath` + 画笔」的 C 代码**（AIR 资源类构造器同步 ⇒ 不能懒加载）。

好消息是**目标模型天然同构**（`skia.md` §4：`Graphics` ↔ `SkPath`/`SkPaint`），所以这是翻译而非新引擎。
**坏消息是运行时能力有硬缺口**：

| 能力 | 现状（`vendor/skia_glue.cc`，1,101 行） |
|---|---|
| 路径 | ✅ `moveTo/lineTo/quadTo/cubicTo/addRect/addCircle/close/getBounds` 均在 |
| 画笔 | ✅ 颜色/alpha/fill/stroke/线宽/抗锯齿 |
| 渐变 | ⚠️ **只有两色线性**（`SkGradientShader::MakeLinear`，2 stops + `kClamp`；`Graphics_beginGradientFill` 还把坐标硬编码成 `0,0→100,0`）。缺径向/焦点、多色停靠、spread/插值 |
| 位图填充 shader | ❌ 无 —— 而本库 **73 处**要用 |
| 描边细节 | ❌ 无 cap/join/miter（`LineStyle2` 字段）、无「描边用填充」 |
| 填充规则 | ❌ 无 `setFillType`（even-odd）—— 本库未用，可延后 |
| **`Graphics` 模型** | ❌ **根本不够用**：现为「一个 `SkPath` + 一个 fill + 一个 stroke」，`endFill` 是空操作、**从不调用 `sk_path_close`**；而真实 `DefineShape` 是**逐子路径**的 `fill0/fill1/line` 索引（§3.4④） |

因此工作量不止「补几个 glue」，还要把 `Graphics` 从「单路径双画笔」升级为「**子路径 + 样式索引表**」模型。

体积量级：位图 42.7 KB（§5.1）+ 矢量 194–233 KB（§3.4②③）≈ **0.28 MB C**，相对 `hello.as` 的 854 KB
仍在「单文件默认形态」可接受范围（§5.1），**不必**强制拆独立 `.c`。另需为 sprite 时间轴/placement
生成代码（3,478 条摆放记录）。

---

## 6. AS3 侧的引用语义：资源类 = `BitmapData` 子类

这是决定 codegen 怎么落地资源引用的关键。实测 `temp/skin.swc` 的 `library.swf` ABC 里：

```
public dynamic class logo extends flash.display::BitmapData
  public function logo(int,int):*
public dynamic class imgback extends flash.display::BitmapData
public dynamic class desktopicon extends flash.display::BitmapData
public dynamic class cambitmap extends flash.display::BitmapData
```

**资源类（`logo`/`imgback`/`desktopicon`/`cambitmap` 等）是 `flash.display.BitmapData` 的动态子类**，
构造器签名 `(int width, int height)`。这是 Flash IDE 导出皮肤库的标准形态。

> **构造器参数会被忽略**——实测 `new logo(0, 0)` 得到的 `BitmapData` 是 **100×72**（真实尺寸来自
> SWF tag），不是 `0×0`。工厂里**必须用资源自身的宽高**，不能采信实参（写成 `new logo(0,0)` 是
> Flash IDE 生态的惯用写法，参数位形同占位）。

而 `SymbolClass` 里 214 条映射中，**只有 16 个位图直接映射到类名**，其余 **43 个位图没有类名**
（被 `Sprite`/`DefineShape` 作为子对象引用）。这 16 个是：

```
desktopicon  logo  imgback  cambitmap
com.vsdevelop.controls.scrollbar.ScrollSkin_{top,middle,bottom,wbottom,wleft,wmiddle,wtop,wright}SkinClass
com.vsdevelop.controls.scrollbar.ScrollSkin_{top,middle,bottom,wmiddle,wtop,wright}SkinClass_200
```

> **早期版本此处有两处错误**：
> ① 举例里的 **`small_gift`/`checkbom` 不属于这 16 个**——实测它们是 **`DefineSprite`（tag 39）**，
> 即 `small_gift` = symbol 19、`checkbom` = symbol 154，落在「需要解析显示树」的那一档（下一节）。
> ② **16 个里有 12 个是全限定名**（`com.vsdevelop.controls.scrollbar.*`）。这对「方式一：直接
> `new 资源类`」是硬约束——现实代码几乎不会写 `new com.vsdevelop....(...)`，滚动条皮肤通常由组件类
> 内部引用或用 `getDefinitionByName` 取。**因此在 `skin.swc` 这类库上，真正可用的是方式二**，
> 只有当库里存在短名资源类（如 `logo` 这种顶层短名）时方式一才好用。

**AS3 侧引用方式（两种，按用户代码风格分）**：

| 引用方式 | 典型代码 | codegen 落地 | 适用范围 |
|---------|---------|-------------|---------|
| 直接 `new 资源类(w,h)` | `var b:Bitmap = new Bitmap(new logo(0,0));` | 资源类注册为 `BitmapData` 子类，`new` 分发到「嵌入像素填充」工厂（忽略实参、用 tag 宽高） | 顶层短名资源（实测 4/16） |
| `SymbolClass` 反射 | `getDefinitionByName("logo")` | 资源注册表 `{name → 工厂指针}`，动态查表 | 全部 16 个（含全限定名 12 个） |

> 反射路径**不再是「后续扩展」**：`emit.ts` 已有 `flash.utils.getDefinitionByName` 注册表
> （`getQualifiedClassName` ↔ `getDefinitionByName` 往返），把资源类登记进去即可复用。
> 鉴于 `skin.swc` 的 12/16 是全限定名，**建议把方式二作为首选落地**，方式一作为便利补充。

---

## 7. 实现落点（对齐 AGENTS.md 分层）

| 层 | 改动 | 说明 |
|----|------|------|
| **构建层 `src/swc.ts`（新增）** | SWC 提取器 | ZIP 解析 + CWS/ZWS 解压 + stage header 跳过 + tag 扫描 + 位图提取 + **反预乘（§3.2）**，产出 `SwcResource[]`（类名/格式/宽高/straight ARGB 像素或 JPEG 字节）。**只读资源，不解析 `DoABC` 字节码**（§3.3）；同时读 `catalog.xml` 的 `<script>/<dep>` 供 §3.3.3 的早期诊断用 |
| **构建编排 `src/build.ts`** | `--swc` 参数 / 构建清单 `swc-paths` | 收集 SWC 依赖，调用提取器；资源段超过阈值时生成独立资源 `.c` 并接入 `sources`（§5.1，**默认不拆**） |
| **语义层 `src/symbols.ts`** | 资源类注册 | 把资源类名注册为 `BitmapData` 子类（`dynamic`，构造器 `(int,int)` 但**实参忽略**） |
| **语义层 `src/emit.ts`** | 资源段发射 + `new`/反射分发 | 发射 C 编码字节资源段（PNG/JPEG，§5.1）；`new logo(w,h)` 分发到「内嵌字节 → Skia 解码 → BitmapData」工厂，宽高取**资源自身**值；资源类同时登记进既有 `getDefinitionByName` 注册表（§6） |
| **运行时 `src/runtime.ts`** | **无需新增** | 所需能力已存在：`as_skia_image_decode_bytes_argb(data, len, &w, &h)`（`emit.ts` 已在 `Loader.loadBytes` 使用），内部走 `DeferredFromEncodedData` + `readPixels(kUnpremul)` → 直接产出 straight ARGB。早期版本列的 `as_skia_image_from_bytes` 是多余的 |
| **构建层 `src/swc.ts`（扩展）** | `DefineShape*` → C 路径构建代码 | 复用现有 ZIP/CWS/tag 扫描链路；shape 解析按 §3.4④，产出「子路径 + 样式索引表」中间表示，再发射 `sk_path_*` 调用。**编译期完成，运行时零 SWF 解析** |
| **语义层 `src/emit.ts` + 运行时 `src/runtime.ts`** | `Graphics` 模型升级 + glue 补齐 | 见 §5.3：子路径/样式索引模型、径向渐变、位图填充 shader、描边 cap/join/miter、`sk_path_close` 语义 |

**边界铁律**：提取逻辑（ZIP/SWF 解析）**只能**发生在编译期（`swc.ts`），**禁止**塞进 `RUNTIME_PREAMBLE`
——那会让运行时背一个 SWF 解析器，违反「前端只翻译」铁律（AGENTS.md §1.3）。反预乘同理放在编译期。

**第二条边界**：`swc.ts` **只读资源，不解析 `DoABC` 字节码**（§3.3）——字节码→C 需反编译器或
AVM2 解释器，属另行立项。`catalog.xml` 的 `<dep>` 只用于**名字层面**的早期诊断（§3.3.3）。

---

## 8. 与 Ruffle 的关系（复用评估）

> **先澄清一个常见误解：Ruffle 不反编译。** 它把 AVM2 字节码当作**可执行产物**直接运行——是 VM/模拟器，
> 不是反编译器，因此永不产出源码。实测其实现（核对 `ruffle-rs/ruffle` master）：
>
> | 环节 | 实际做法 |
> |---|---|
> | `swf/src/avm2/read.rs` | 把 ABC 解成**自己的 IR**（`AbcFile{constant_pool, methods, metadata, instances, classes, scripts, method_bodies}`），且 `read_op()` 把每条字节码解成 `Op` 枚举 |
> | `core/src/avm2/activation.rs` | `loop { match op { Op::PushDouble{..} => self.op_push_double(..), … } }`——**解释器主循环** |
> | `core/src/avm2/optimizer.rs` + JIT | 代码原注释：「Most methods are executed in **JIT mode**」——是**运行时** JIT，不是编译期生成 C |
> | `core/src/avm2/verify.rs` / `swf/src/avm2/write.rs` | 字节码校验器 / 回写器（测试用） |
>
> 所以「没有源码」对 Ruffle 根本不是问题（它不需要源码）；对我们是问题（我们要翻译成 C，见 §3.3.2）。
> 但如 §3.3.0 所示，本体量里真正缺源码的只有 3 KB 的 mx/flex 类——因此**我们也不需要模仿它的解释器路线**。

Ruffle 的 `swf` crate 有完整的 `read_tag_with_code`（含 `DefineBitsLossless`/`DefineBitsJPEG` 解析），
**但不可移植**（Rust + `gc_arena` GC）。它的价值是**参考实现**：

- `swf/src/read.rs` 的 tag 头解析、`DefineBitsLossless2` 字段偏移（`characterID/bitmapFormat/width/
  height/zlibData`）可作为我们 `swc.ts` 手写解析器的**格式对齐基准**；
- `make_lzma_reader`（mangled LZMA header 处理）只在 `ZWS` 时有用。**注意**：SWF 的 `ZWS` 布局
  已在 §4 实测给出，与 LZMA-alone 的 13 字节头不同，照抄 `make_lzma_reader` 反而会错。
- `swf/src/avm2/read.rs` 的 `read_trait` / `read_method` / `read_constant_pool` 是 **ABC 段序的权威
  基准**（§3.3.1 的四个语义坑即由此定案）；同样只作参照，不引入代码。

**不引入 Ruffle 代码**，只用它对齐格式细节。

---

## 9. 分阶段计划（**已立项：阶段九十五**）

> **本节的阶段编号已作废**：早期草案占用了「阶段六十六 / 六十七 / 六十八」，这三个编号已被
> **其他已完成功能**使用——六十六 = `Vector.<T>` 高阶/序列方法（v0.3.69）、六十七 = 三子系统
> deferred 收尾（v0.3.70）、六十八 = `--package xcode-project` 工程生成器（v0.3.71）。
> 照原文阅读会误以为 SWC 已实现。**实现启动时再向 `TODO.md` 申请新编号**。

> **立项决定（2026-10-05，用户敲定）**：
> ① **编号 = 阶段九十五**（另起顶层号，与 阶段八十九 / 九十四 同级，而非续 `九十四·三十`）；
> ② **A~E 五步同批交付**，矢量不另立项——否则 SWC 皮肤「只有位图没有矢量」，且 73 处位图填充本身就在 shape 里；
> ③ 首期在 §10 延后表之上**额外纳入两项**：**九宫格缩放（`DefineScalingGrid`，22 个）**与
> **按钮四态（`DefineButton2`，29 个）**，见下方 **F**；其余（时间轴动画 / SWC 内嵌字体 / morph / `ZWS` / 声音）保持延后；
> ④ 运行时 glue 按**本库实测最小面**补齐（位图填充 shader + 实色/线性渐变 + 描边 cap/join/miter；
> 径向/焦点渐变与 even-odd 本库实测为 0，延后）；
> ⑤ 其余默认：资源类引用**两条路都做**（`getDefinitionByName` 优先、直接 `new` 作便利补充，§6）、
> 反预乘取 `floor(stored*255/A + 1/3)`（§3.2）、早期诊断 **D 随首期**、资源段**默认内嵌同一 `.c`**（§5.1）、
> `Graphics` 组模型**一次做全**并顺带关闭 `TODO.md` 既有的同源遗留行（「多个 `beginFill/endFill` 组嵌套」，阶段九十四·二十二 登记）。

- [ ] **A. `src/swc.ts` 提取器（编译期）**：ZIP central directory 解析 → `library.swf` ZIP 层 raw-inflate
      → CWS `inflateSync`（ZWS 按 §4 布局）→ 跳过 stage header → 扫 tag；提取
      `DefineBitsLossless2`(tag 36)/`Lossless`(tag 20，补 `A=0xFF`)/`DefineBitsJPEG2/3`；
      **按 §3.2 做反预乘**，再**重编码为 PNG**（JPEG 标签则保留原字节）；解析 `SymbolClass`(76) 的
      `{id → className}`。产出 `SwcResource[]`（`className`/`format`/`width`/`height`/**`encoded` 字节**）。
      含一个约 100 行、零依赖的 PNG 编码器（Node `zlib`，见 §5.1）
- [ ] **B. 资源类注册 + 嵌入字节填充（codegen）**：`symbols.ts` 注册为 `BitmapData` 子类；
      `emit.ts` 发射资源段（§5.1，**默认内嵌同一 `.c`**）+ `new`/`getDefinitionByName` 两条分发路径，
      工厂内走**已存在的** `as_skia_image_decode_bytes_argb` 解码（§5、§7，**不新增运行时 API**）
- [ ] **C. CLI / 清单接入 + 收尾**：`--swc`（可多个）+ 清单 `swc-paths`；回归全部旧示例；版本号递增
- [ ] **D. 早期诊断（小、但建议随首期一起做）**：读 `catalog.xml` 的 `<script>/<dep>`，对「引用了
      只以 ABC 字节码存在于 SWC 的类」给出编译期报错（§3.3.3）。**不反编译任何东西**，只做名字层面的
      集合运算。它是「用户代码引用了 SWC-only 类」这个必然场景的兜底，成本极小
- [x] **E. `DefineShape` 烘焙 + `Graphics` 模型升级（与 A~C **同批**，否则皮肤「只有位图没有矢量」）**：
      `swc.ts` 扩展 shape 解析（§3.4④，产出「子路径 + 样式索引表」中间表示）→ `emit.ts` 发射 `sk_path_*`
      构建代码；运行时补 glue（径向/焦点渐变、位图填充 shader、描边 cap/join/miter、`sk_path_close`），
      并把 `Graphics` 从「单路径双画笔」升级为「子路径 + 样式索引表」（§5.3）。范围含显示树：
      `DefineSprite` 时间轴 + `PlaceObject*` 的矩阵/颜色变换（**第 1 帧足够跑静态皮肤**；时间轴动画与
      morph 仍在 §10 延后表 —— 其中**多帧时间轴已由 G·九 补齐**，见 §9.2 F6；九宫格与按钮四态已改入首期的 **F**）。
      **已完成，实测数据见 §9.1**
- [x] **F. 九宫格缩放 + 按钮四态（首期纳入，2026-10-05 决定）**：`DefineScalingGrid`(78, 22 个) →
      运行时 `scale9Grid` 拉伸语义（否则缩放时糊）；`DefineButton2`(34, 29 个) → `ButtonRecord` 解析 +
      按钮状态机（up/over/down/hit 四态 + 命中翻转）。两者都建立在 A~E 的显示树/shape 烘焙之上。
      **已完成，实测数据见 §9.2**
- [x] **G. `PlaceObject3` 属性 + 显示列表可观测面（后续三轮，2026-10-06）**：`Visible=0`（·六，v0.4.64）、
      `FILTERLIST`/`BlendMode`/`BitmapCached`（·七，v0.4.65）、以及未支持字符（`DefineEditText`/`DefineText`/`morph`）
      的**占位子件** + `clipDepth` 遮罩子件 + placement 平移→子件 `x/y` + Shape 声明包围盒（·八，v0.4.66）。
      以及多帧**时间轴烘焙** + `FrameLabel` + `MovieClip` 时间轴 API（·九，v0.4.68）。
      **已完成，实测数据见 §9.2 F3/F4/F5/F6**

### 9.1 E 实测结果（2026-10-05，可复现）

**方法**：`temp/swc-render/`（harness 由 `gen.ts` 从 `temp/skin.swc` 生成一份共享 body，两侧分别用
本编译器与 `adl` 渲染同一批导出符号到 `ours.txt` / `adl.txt`；比较器 `compare.ts`）。每个符号给出
64 格 8×8 的 alpha 加权格均值指纹（`fp`）、非透明像素数 `nz`、以及原始 ARGB dump
（`raw_<id>_{ours,adl}.png` + `cmp_<id>.png`）。

**词表**：`exact` = 指纹/nz/sum 全等；`tol16` = 全部 64 格 alpha 均值差 ≤ 16；`no-struct` = 无任何格
alpha 差 > 64（即无结构性缺失）；`colour-ok` = 无结构性差异且**已着色格**（两侧 alpha 均值 ≥ 32）
每通道差 ≤ 16。

**结果（200 个符号 = 4 位图 + 196 显示符号）**：

| 桶 | 总数 | exact | tol16 | no-struct | colour-ok |
|---|---|---|---|---|---|
| bitmap | 4 | 3 | 1 | 1 | 1 |
| display（无文本） | 39 | 2 | 37 | 37 | 27 |
| display（含文本） | 157 | 0 | **90** | **120** | **23** |

> 上表于 **2026-10-06** 随两处修复刷新：① `PlaceObject3` 可见性（§9.2 F3）`no-struct 118 → 120`、
> `colour-ok 21 → 22`；② `PlaceObject3` 的 Filter / BlendMode / BitmapCache（§9.2 F4，含滤镜
> `strength` 与模糊 σ 的对齐）`colour-ok 22 → 23`，`tol16`/`no-struct` 保持不变。bitmap 与
> display（无文本）两档全程不变。
>
> 分桶口径于 **2026-10-06** 再调一次（§9.2 F5）：`元件27_310` 的 morph 遮罩现在是**子件**，而
> 「含文本」桶的判据是闭包内有文本**或 morph** 字符 ⇒ `display（无文本） 40 → 39`、
> `display（含文本） 156 → 157`，**各桶计数不变**（它是该桶本就唯一的结构性差异符号，移走后
> 两个桶的 `exact/tol16/no-struct/colour-ok` 都不变）。

**逐项归因**：

- **位图 3/4 逐位精确**，第 4 个（`cambitmap`）仅 1 格越界，属 §10 已登记的 Skia 反预乘 ±1 通道漂移。
- **含文本符号（156 个）**：`DefineEditText`(338)/`DefineText` 未实现（§3.3），文本区必然为空——
  这是首期范围外的**已声明缺口**，不是回归。它们的 tol16 达 90/156，说明文本之外的矢量部分已对上。
- **无文本符号 37/40 在 tol16 内**，其中 27 个连已着色格也在 ±16 内。
- **`skin_fla_元件27_310`（charId 215）是唯一的无文本结构性差异**：它的 frame 1 用 charId **209**
  （`DefineMorphShape`，§10 延后）**当遮罩**（`clipDepth=3` 覆盖 depth 2 的子件）。morph 遮罩无法
  表达为路径裁剪，因此该子件未被裁剪 ⇒ 我们多画（nz 6104 vs adl 3973）。**已按「绝不静默」原则**
  记入 `swcBake.notes` 报明；自 §9.2 F5 起遮罩对象**保留为子件**（不再标 `unsupported`）。
- **其余无文本差异都是低幅色彩/抗锯齿级**（多数已着色格也在 ±16 内）。抽样逐像素归因：边缘覆盖
  差 1 个像素（ours `14,255,255,255` vs adl `0,0,0,0`）属于抗锯齿；`元件163_149` 是 1px 细特征差。
- **~~仍开放 1 项~~ 已结案（2026-10-06，§9.2 F3）**：`vbitemskin`（charId 293，146×112）有 541 个像素 ours=灰 `0x999999` vs adl=白，
  而**两侧 64 格 alpha 均值完全相同**（`maxda=0`）⇒ 两边的**覆盖形状一致**，只是该处填色不同。
  该符号的树为 depth 1 `#282`（→ 灰矩形 `#86`，30.5×11px 缩放 2.69×4.36）、depth 3/4 白矩形
  `#283`（80×45.5px @1,1）、depth 6 `#286`→`#285`（灰身+白三角）、depth 9 三个点（带
  `ColorTransform` 变白灰）、depth 21 关闭按钮；差异区恰好落在白矩形 `#283` 与灰矩形 `#86` 的交集。
  已用字节级复核确认：`#282` 的 `PlaceObject2` 无颜色变换、无 `clipDepth`（flags=0x06），矩阵与
  scale 正确 ⇒ **解析无误**；`adl` 的 `#86` 填色确为 `DefineShape`(code 2) 的 RGB `99 99 99`（灰）
  ⇒ 也无法用「填色解析错」解释。**根因已定位**：`#282` 所在的 depth 6 兄弟 placement（#286）带
  `PlaceObject3` 的 `Visible = 0`，AIR 不画它、我们把该字段读完就扔（§9.2 F3）。修后该符号
  `maxdcS 76 → 30`，残留属抗锯齿/色彩级差。原复现命令：
  `cd temp/swc-render && node gen.ts && node ../../src/index.ts scene.as --manifest t.build.json --run && ./run_adl.sh && node compare.ts`。

**验收基线（可直接复用本次复核的数据）**：对 `temp/skin.swc` 跑提取器，
① 16 个命名资源全部提取；② `logo` 为 100×72 且为**反预乘后**的值（先解出 straight ARGB，再编码成 PNG）；
③ **与 `adl` 的 `getPixel32` 逐点比对**（§11 的方法），允许 ±1 通道偏差；
④ 体积：16 个资源的编码字节合计 ≈ **14.6 KB**（PNG），C 源码 ≈ **43 KB**（而非 7.42 MB）；
⑤ 矢量：**378/378** shape 解析 round-trip 全中，且导出符号闭包（322 shapes / 327 sprites）的渲染结果
与 `adl` 截图对照（§3.4、§11⑤）；
⑥ 九宫格缩放（22 个 `DefineScalingGrid`）与按钮四态（29 个 `DefineButton2`）与 `adl` 截图对照；

### 9.2 F 实测结果（2026-10-05，可复现）

F 的两项都把「AIR 到底怎么表现」先量出来，再决定实现口径；两者都**零运行时新 API**（只有 `Graphics`/
`DisplayObject` 内部状态与 paint 路径）。

#### F1 九宫格缩放（`DefineScalingGrid`, tag 78）

**解析**：22 个 grid 全部落在 sprite 上，rect 以 twips 给出（`lib.scalingGrids: Map<id, SwcRect>`）；
烘焙时除 `TWIPS = 20` 转为 px 写入 `SwcBakeCharacter.scalingGrid`，**22 个烘焙角色全部带 grid**。
只有 `#545 元件97` 有导出类名（即 harness 的 entry 103，`w:251 h:89`）。

**关键语义（实测钉定）：AIR 只对角色**自己的 `scaleX`/`scaleY`** 做九宫格拉伸，对时间轴 `PlaceObject`
矩阵的拉伸不生效。** 两条独立证据：

| 实验 | 结果 |
|---|---|
| 1× A/B（临时 `ASC_NO_S9` 开关），让「时间轴 placement 触发 grid」参与 | 与 `adl` 的差异面**反向扩大**（42 个 entry 变差）⇒ placement 拉伸不该触发九宫格 |
| entry 103 经容器 2× 拉伸后的 RAW 逐像素对比 | grid **ON**：与 `adl` 差 51 px（0.06%），`nz` 18674 vs `adl` 18676；grid **OFF**：差 200 px（0.22%），`nz` 18568 |

⇒ 实现按此落地：`emitSwcPlacement` **永远**把 SWF 矩阵写进 `transform.matrix`（绝不写进对象自己的
`x/y/scaleX/scaleY`），因此被 placement 拉大的嵌套 sprite **不**走九宫格——与 AIR 一致。

**运行时**：`as_render_object` 派发链首项为 `if (o->_s9_on && (o->scaleX != 1.0 || o->scaleY != 1.0))`；
新助手 `as_render_nine_slice` 按自然尺寸烘焙一次（复用 `as_render_cached` 的机制与 `ASC_bake_ctm_x/y`
补偿，有 filter 时走 `as_render_filtered`），再按 9 组 src/dst 条带重组；**边框条带在本地单位里除以
缩放**，这样已经施加的 canvas 变换把它落回自然尺寸；极度缩小时中段夹到 ≥ 0、边框按比例收缩。
条带取样用 `sk_canvas_draw_image_src_rect`（`kStrict_SrcRectConstraint`，中段不会采样到边框）。

#### F2 按钮四态（`DefineButton2`, tag 34）

**解析**：`ButtonRecord.states` 位掩码（0b0001 up / 0010 over / 0100 down / 1000 hit）；29 个按钮全部
烘焙，其中导出两个：`#957 downvpage`、`#961 upvpage`。以 `upvpage` 为例（`states=5` 条记录）：

```
up    : 958
down  : 954 + 960      ← 与 over 共享 954，第二个不同（AIR 下这就是青色三角）
over  : 954 + 959
hit   : 960 + 252(scale 0.714, 0.261)
```

**状态机**：`as_sbtn_state` 在**绘制时**按实时指针状态选择——`down`（hover ∧ mouseDown）、`over`、
否则 up→over→down→hit 回退。指针状态（`ASC_mouse_x/y/has/down`）由 `Stage_dispatchMouse` 统一写入，
因此**窗口的 SDL 回调与 AS3 的 `stage.dispatchMouse(x,y,type)` 测试钩子都会驱动四态**；窗口外
（`BitmapData.draw`）`ASC_mouse_has = 0`，只看 up 态——这也是 §9.1 的离屏验收只比 up 态的原因。

**命中判定（本项真正的坑）**：窗口探针里 hover 恒为 0。根因：`as_sbtn_contains` 最初用
`as_pick_hit`，而它**只报告 InteractiveObject**；按钮的 hit 态是用**普通 `Shape`** 搭出来的，于是永不命中。
改为几何判定——把舞台点映到按钮本地空间，再映射进 hit 态自身空间，调用
`as_obj_region_hit_local`（走它自己的子件与轮廓），即 AIR 真正命中的那块区域。修复落在**共用助手**层：
拆出 `as_sbtn_contains_local`（本地空间）供 `as_sbtn_contains`（舞台空间）与 `as_obj_region_hit_local` 共用，
因此 `SimpleButton.hitTestPoint(x, y, true)` 也跟着按 hit 态几何判定（此前恒为 miss）——
结构回归见 `examples/swc-shape.as`。

**结果**：

| 途径 | up | over | down | 回退 |
|---|---|---|---|---|
| ours 离屏（`temp/btnstate/off.as`，三角像素） | `4dfcfcfc`（淡） | `ffffffff`（白三角） | **`ff00948c`（青）** | `ffffffff`（可逆） |
| `adl` 窗口截图 | 淡白 | 白三角 | **(0,147,139) = `0x00938b`（青）** | — |

⇒ 下态青色 ours `0x00948c` vs `adl` `0x00938b`，差在截图的色彩管理漂移之内，**四态表现一致**。

**harness 说明**：窗口侧 ours 只稳定抓到 up/over/回退三态，press 那一帧的报图未复现（`adl` 侧四态齐全）。
同一套 paint 路径（`as_render_object`）在离屏探针里与 AIR 逐像素一致，故判为**窗口报图/harness 限制**，
非实现缺口；离屏探针 `off.as` 是四态的确定性验收口径。

#### F3 `PlaceObject3` 的属性：可见性已实现，Filter / BlendMode / BitmapCache 仍丢弃

**缘起（2026-10-06 普查发现）**：`readSwfPlacement` 一直把 `PlaceObject3` 的三个属性读完就扔。
普查 `temp/skin.swc`（`temp/swc_po3_visible.ts`）：**64 条 `PlaceObject3`，其中 63 条落在导出符号的
烘焙闭包内**——`hasVisible` 38 条、`FILTERLIST` 13 条、`BlendMode` 8 条、`BitmapCached` 2 条。

**① 可见性（`Visible`，已实现）**：38 条带 `Visible` 字段的记录**全部是 `0`**（AIR 不画）。
实测口径（`temp/vishidden/`，两侧同一段 body：`numChildren` + 逐子件 `visible`）：

| 符号 | `adl` | 我们（修前） |
|---|---|---|
| `vbitemskin`(#293) | 6 个子件，`c3.visible == false`（藏在 depth 6 的 #286） | 5 个（子件被整条跳过） |
| `fileitemdoctorskin`(#63) | 7 个，其中 2 个 `visible == false` | 4 个 |
| `fileitemskin`(#389) | 5 个，其中 2 个 `visible == false` | 2 个 |
| `homeskin`(#1121) | 7 个，全可见 | 7 个 ✓ |

⇒ **AIR 会建出子件并置 `visible = false`，不是省略该 placement**。实现据此落地：烘焙侧把
`hidden` 带到 `SwcBakePlacement`，发射侧 `if (p.hidden) c->visible = false;`。渲染侧本就跳过
不可见子件（`as_render_object_content` 的 `!ch->visible` 分支），所以**像素与「整条跳过」完全一致**，
而对象树也对齐了 AIR。（只跳过的写法能骗过像素对比，但 `numChildren`/`getChildAt(i).visible` 会露馅。）

**像素收益（1× 全量重测，42 个 entry 变化，全是变好）**：`maxdcS`（已着色格最大通道差）
在带 `Visible = 0` 的符号上普遍塌下来——`fileitemdoctorskin` **205 → 2**、`setupskin` 239 → 31、
`mymtskin` 211 → 30、`subtitleskin` 181 → 22、`surveyhdskin` 185 → 61、`systemUpdateSkin` 154 → 37、
`onlineskin` 73 → 24、`cretaemeetingskin` 39 → 17、`vbitemskin` **76 → 30**；结构性档位
（`no cell alpha diff > 64`）上 `元件1_3`/`元件2_6` **struct 16 → 0**、`userskin` 4 → 1、
`filepreviewskin` 2 → 1。汇总：text 档 `no-struct 118 → 120`、`colour-ok 21 → 22`；bitmap/display 两档不动。

⇒ **§9.1 末条那个「未定位」的 `vbitemskin` 灰/白差异，根因就是这条**：depth 6 的 #286 被 AIR 隐藏、
被我们画了出来（覆盖形状相同、只有填色不同，正是隐藏对象压在不透明白矩形上的signature）。

**② 当时仍未实现**：`FILTERLIST`（13 条）、`BlendMode`（8 条）、`BitmapCached`（2 条）当时仍是
**读到位后丢弃**，属 AIR 已定义行为 ⇒ 遗留缺陷。**已实现，见 §9.2 F4**。

**复现**：

```
# PlaceObject3 属性普查（有多少条、在不在烘焙闭包内、Visible 的实际取值）
node temp/swc_po3_visible.ts ../temp/skin.swc
# 对象树对照（ours 与 adl 各一份，逐子件 visible）
cd temp/vishidden && node gen.ts && ../../src/index.ts ours.as --manifest t.build.json --run && ./run_adl.sh && diff adl.txt ours.txt
# 1× 全量像素重测（§9.1 的同一套 harness）
cd temp/swc-render && <ours> && ./run_adl.sh && node compare.ts

# 结构回归（矢量/显示树/九宫格/按钮四态，两侧构建都成立）
cd as3compiler && node src/index.ts examples/swc-shape.as --swc ../temp/skin.swc --run
# F1 九宫格（entry 103 = 元件97，#545 有 grid）
cd temp/swc-render && RAW=103 SCALE=2,2 node gen.ts && <ours> && ./run_adl.sh && node rawpng.ts 103
# F2 按钮四态（离屏，确定性）
cd as3compiler && node src/index.ts temp/btnstate/off.as --manifest temp/btnstate/off.build.json --run
# F2 按钮四态（窗口，ours 自驱 + adl 真光标）
cd temp/btnstate && node gen.ts && python3 drive.py <repo>/temp/btnstate/ours <AIRSDK>
```

---

### 9.2 F4 `PlaceObject3` 的 Filter / BlendMode / BitmapCache（阶段九十五·七，v0.4.65）

**背景**：§9.2 F3 普查出 63 条 `PlaceObject3`，其中 13 条带 `FILTERLIST`、8 条带 `BlendMode`、
2 条带 `BitmapCached`，而这三项此前**被解析后整段丢弃**（`SwcPlacement` 连字段都没有）。
它们全是 AIR 已定义行为 ⇒ 遗留缺陷，本阶段一次补齐。

**属主分布**（`node temp/swc_po3_detail.ts ../temp/skin.swc`，只统计在烘焙闭包内的条数）：

| 属性 | 条数 | 细节 |
|---|---|---|
| `FILTERLIST` | 13 | 11 × Glow、2 × DropShadow |
| `BlendMode` | 8 | 7 × 值 2 (`layer`)、1 × 值 6 (`darken`，`homeskin` depth 2) |
| `BitmapCached` | 2 | `mymtskin`/`subtitleskin` 一族 |

Glow 记录形态一致：`Glow{color:0xff000000, blurX/Y:16, strength:0.19921875, quality:1, inner:0,
knockout:0, composite:1}`（`#343 staticskin` 的 char #324；`#647 editnickname` blur 17；
`#672 filepreviewskin` 的 d3 char #660 是**白** Glow、blur 6、strength 10）；
DropShadow 两条同形：`{color:0x7f000000, blurX/Y:10, angle:0, distance:0, strength:0.5390625,
quality:1}`（`#925 skin_fla.元件124_72` 的 d1 char #923 与 `#931 ()`）。

> **注意 `0xff000000` 的读法**：SWF 里 GLOW 的 `GlowColor` 是 **RGBA**（高位是 alpha），
> 而 AS3 `GlowFilter.color` 只吃 RGB —— 所以 `0xff000000` 落到 AS3 侧是 `color = 0`
> （黑）而 `alpha = 1`。`0x7f000000` 同理 → `color = 0`、`alpha = 0.5`。
> `alpha` 与 `strength` 是两个独立量（见下），早期把二者混为一谈会算错强度。

**对齐 AIR 的两处关键实测**（本阶段的实质工作，均在 adl 51.4.1 上量出）：

1. **`strength` 是「模糊之后」的强度系数，且 AIR 的模型是 `min(1, 剪影 × 颜色 alpha × strength)`**
   （`temp/filterprobe/`：40×40 黑矩形画进 `BitmapData`，逐点读 alpha）。
   Glow 的 `strength` 0.2/0.5/1/2 → 暗度 4/10/21/42（每单位 0.0785/0.0785/0.0824/0.0824，
   **线性**）；`GlowFilter(alpha 0.5, strength 2)` 与 `strength 1` 渲染**完全一致**；
   DropShadow `strength` 0.5/2 → 27/110（比值 4.07）。⇒ 必须在**模糊之后**乘。
   - 反面教训（两次都实测证伪）：
     * 完全忽略 `strength`：每个烘焙光晕都以满不透明度作画（`staticskin` 的 nz 一度 41094 → 52503）。
     * 在**模糊之前**把 `alpha*strength` 夹到 1 再上色：`strength 2` 会塌成剪影（0.212 而非 0.431）；
       而且剪影本身不透明，前置 alpha 因子 ≥ 1 完全饱和 —— 曾出现 `strength 1` 与 `strength 2`
       的光晕**一模一样**，直到把缩放挪到模糊之后才分开。
   - 实现：`vendor/skia_glue.cc` 的 `sk_alpha_scale_after(strength, inner)` —— 单位矩阵 + 一行
     alpha `{1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,strength,0}`，用 `SkImageFilters::ColorFilter`
     包住内层滤镜；glow 与 drop shadow 各在模糊之后接一层。

2. **AIR 的模糊是「直径 = `blurX` 的 box 模糊重复 `quality` 次」，不是高斯**
   （同一探针，逐点 alpha）：`blur 6, q1` → 距边 -1/0/1/2/3/4 px 的 alpha
   191/148/106/63/21/0（即 0.75/0.583/0.4167/0.25/0.0824/0，`d = 4` 起**为 0**，有限支撑）；
   `blur 12, q1` → d2 74、d4 31；`blur 6, q3` = 3 个 box 叠加。
   直径 b 的 box 方差为 `b²/12` ⇒ **方差匹配等效 `sigma = blur * sqrt(quality) / sqrt(12)`**，
   取代原来的经验值 `blurX / 3.0`（后者对 `quality > 1` 完全无感，也做不出「4 px 外为 0」）。
   实现：生成 C 里新增 `static double as_filter_sigma(double blur, int quality)`。
   - **残留口径（已登记，不打算修）**：Skia 的模糊是「3 个 box 逼近高斯」，所以我们的剖面中部更陡、
     尾部更薄：`blur6q1` 实测 ours 217/161/94/38/9 vs AIR 191/148/106/63/21。要逐点一致得用
     `MatrixConvolution` 做真 box（每层 36~256 抽头、非可分离），性能风险大于收益。

3. **DropShadow 的「双重缩放」事故（必须在文档里留痕）**：
   `strength` 的缩放一开始被套在 Skia `SkImageFilters::DropShadow` 的**输出**上 —— 但 Skia 这个工厂
   是「阴影 **+ 源**」的合成结果，于是**源自身也被乘了 `strength`**。症状：1× harness 里两个带
   DropShadow 的符号（`popcontrolskin`、`skin_fla.元件124_72`）struct 0→12/14、`maxda` 6→118；
   逐像素质证 `RAW=29`（popcontrolskin，425×124）**36.34% 像素不同**，逐格 alpha 图显示整条 bar 的
   alpha 是 **137/255 = 0.537**，而该记录的 `strength` 正是 **0.539** —— 源被整体打薄了 54%。
   ⇒ 现在按**两个都精确的区间**分流：
   * `alpha*strength ≤ 1` 且需要源：把整份印记烘进**阴影颜色**（`alpha*strength`），用
     `SkImageFilters::DropShadow` 让 Skia 自己把源合成上去，**调用方不再重画源**；
   * 否则（印记会越过 1，或 AIR 的 `CompositeSource = 0` / AS3 的 `hideObject` 不画源）：
     用 `SkImageFilters::DropShadowOnly` + 模糊后 `strength` 缩放，源由调用方另画一遍 ——
     正好复现 AIR 的饱和区间（`alpha 1, strength 2` → 边纹 0.431，而非夹取后的 0.212）。
   生成 C 侧对应 `int drawSource = !ds->_shadow_only;` 与
   `if (drawSource && ds->alpha * ds->strength > 1.0) as_render_filtered(...)`。

**落地映射**：

| SWC | AS3 / C 运行时 | 说明 |
|---|---|---|
| `FILTERLIST` 0 DropShadow | `DropShadowFilter_new(...)` | 颜色按 RGBA 拆成 `color`（RGB）+ `alpha`；`CompositeSource = 0` → `hideObject = true` |
| `FILTERLIST` 1 Blur | `BlurFilter_new(bx, by, passes)` | `passes` 直接进 `quality` |
| `FILTERLIST` 2 Glow | `GlowFilter_new(...)` | 同上；`CompositeSource = 0` 无 AS3 对应字段，走 C 运行时私有位 `_shadow_only` |
| `FILTERLIST` 3–7 | **报明**（`notes`） | Bevel / GradientGlow / Convolution / GradientBevel / ColorMatrix 只按文档长度跳过字节，不静默 |
| `BlendMode` | `DisplayObject.blendMode`（String 槽）+ `BlendMode` 常量类 | `layer` = 纯分组隔离（`saveLayer` + `kSrcOver`，glue 返回 1）；`darken/multiply/screen/lighten/difference/add(→kPlus)/overlay/hardlight` 映射到 `SkBlendMode`；**Skia 表达不出的模式返回 0 并报明**，不近似 |
| `BitmapCached` | `DisplayObject_set_cacheAsBitmap(true)` | 与 AS3 `cacheAsBitmap` 同一路径 |

**两处结构决策**（都是「AS3 属性可读、C 字段布局不变」的既有手法）：

- **`blendMode` 是普通 String 槽**（同 `name`）：默认字面量 `"normal"` 放 rodata，无需写屏障。
- **`cacheAsBitmap` 改成私有后备槽 `_cache_flag`**：AS3 静态类型的字段读会直取 C 结构槽、
  **绕过访问器**，所以 `cacheAsBitmap` 若仍是公开槽，`c.cacheAsBitmap` 就读不到「OR 上 `filters`」
  的语义。现在公开名只留在 `getters`/`setters`，`get` 体为
  `if (o->_cache_flag) return true; return o->filters != NULL && o->filters->length > 0;`
  （AIR 实测：设过 `filters` 的对象 `cacheAsBitmap` 报 true），C 侧与渲染侧仍用
  `_cache_flag`（`temp/attrsprobe/` 的 cache 列改后与 AIR 逐项一致）。
- **混合层是 `as_render_object` 最外层的包裹**（色彩变换 `ct` 与 `clipDepth` 都在它里面），
  还原顺序 clip → ct → blend。

**验收**（1× harness，与 §9.1 同一套；基线文件 `temp/swc-render/rep_final.txt`）：

```
bitmap  total=4    exact=3  tol16=1  no-struct=1  colour-ok=1
display total=40   exact=2  tol16=37 no-struct=37 colour-ok=27
text    total=156  exact=0  tol16=90 no-struct=120 colour-ok=23
params: ours lines 200, adl lines 200, ERR ours/adl 0/0
```

即：bitmap 与 display（无文本）**两档不动**，含文本档 `tol16/no-struct` 不动、`colour-ok 22 → 23`。
逐符号则是**一边倒变好、无一处变差**（`staticskin` maxdc 93 → 35 / maxda 7 → 3、
`popinfoskin` maxdc 185 → 79、`poproomIdsskin` maxdc 100 → 13、`popnoticskin` maxdcS 34 → 5、
`poppluginskin` maxdcS 10 → 7、`popmiccamskin` maxdcS 4 → 1、`popgiftskin` maxdc 38 → 23、
`popsubtitleskin` maxda 5 → 3 —— 且 v0.4.64 时曾变差的两个 DropShadow 符号已回到基线）。

**复现**：

```
# Po3 属性普查（含种类直方图与逐条形态）
node temp/swc_po3_detail.ts ../temp/skin.swc
# 强度模型 / box 模糊模型 / 不变量（两侧各跑一次，CHK 逐行相同）
cd temp/filterprobe && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh
# 属性指纹（滤镜子件、blendMode、cacheAsBitmap 逐项对 adl）
cd temp/attrsprobe && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && diff adl.txt ours.txt
# DropShadow 双重缩放事故的逐像素质证（entry 29 popcontrolskin 425x124）
cd temp/swc-render && RAW=29 node gen.ts && <ours> && ./run_adl.sh && node rawpng.ts raw_ours.bin raw_adl.bin . && node pixq.ts 29
# 1× 全量像素重测
cd temp/swc-render && <ours> && ./run_adl.sh && node compare.ts
# 结构回归（glow / darken / layer / cacheAsBitmap 的树与字段断言，纯结构、不依赖 Skia）
cd as3compiler && node src/index.ts examples/swc-shape.as --swc ../temp/skin.swc --run
```

---

### 9.2 F5 未支持字符的占位子件 + 子件变换/包围盒对齐（阶段九十五·八，v0.4.66）

**背景**：`temp/childfx/` 探针（15 个导出符号 / 99 个子件）逐子件对 `adl` 打印 `numChildren`、
`getQualifiedClassName`、`x/y`、`width/height`、`transform.matrix`、`visible`。修前：`x/y` **全错**
（我们一律 `0,0`）、`numChildren` 偏少（`minfo` 我们 2 vs `adl` 6）、`width/height` **39 处**不符。
修后：**`x/y` 0 处不符、`numChildren` 0 处不符、`width/height` 35 处**（其中 3 处源自 morph 几何缺失，
其余 ≤0.021px 的精度级差）。

**① 未支持的字符建为占位子件（绝不静默）**

- `DefineEditText`(37) / `DefineText`(11)：实测本库 **341 个**（338 + 3）⇒ 烘焙成**空 `TextField`**
  （`as_swc_new` 的 `'text'` 分支 = `TextField_new()` + `_fieldWidth/_fieldHeight` 取声明的 `RECT` 尺寸），
  于是 `numChildren` / `getChildAt` 索引顺序与 AIR 一致。字形与初始文本仍是**已声明缺口**，
  用 `notes` 报明（`341 DefineText/DefineEditText character(s) are baked as EMPTY TextField placeholders …`）。
- `AutoSize` 实测：`DefineEditText` 第二 flags 字节的 `0x80` 位在本库 **341 个全为 0**；我们已把它解析出来
  （`SwcText.autoSize`），既然全为 0，占位框按 `RECT` 报即与 AIR 无差。
- `DefineMorphShape`(46) / `2`(84)：实测闭包内 **6 个** ⇒ 烘焙成**空 `Shape`**（AIR 是 `MorphShape`，
  `Shape` 的子类；本工程无此类，故 `getQualifiedClassName` 报 `Shape`）。树形（个数/索引）对齐、
  **不画错像素**（空 Shape 不画），几何缺失用 `notes` 报明。
- 旧实现是「`unsupported` ⇒ 摆放处直接跳过」，会**连子件都没有**；现在是「建占位 + 报明」。
  `is TextField` 对文本子件成立（`examples/swc-shape.as` ⑦ 断言）。

**② `clipDepth` 遮罩对象是子件，不是「不存在的子件」**

实测 `skin_fla.元件27_310` 的 `c0` 在 AIR 里是 `MorphShape`、`visible=true`、有自己的包围盒（1×18），
只是**从不被绘制**。修前我们把遮罩字符标 `unsupported` —— 那会让该字符**在任何位置**都不再出现（潜在 bug）。
现在改为：遮罩摆放**保留为子件**，另置私有字段 `_mask_object`（C 运行时专用；DisplayObject 构造时 `false`），
`as_render_object` / `as_pick_hit_m` 见到就整体跳过。morph/sprite 遮罩无法表达为路径裁剪 ⇒ 一句 `notes`
报明（`clipDepth mask …`），不再 `unsupported`。实测 `fileitemskin.c2`：AIR `n=4`（含 `MorphShape` 遮罩）
↔ 我们 `n=4` ✓。

**③ placement 平移落到子件自身 `x/y`（scale 仍留在 `transform.matrix`）**

`emitSwcPlacement` 现在只把 2×2（旋转/缩放/斜切）写进 `transform.matrix`，**平移**写进子件自己的 `x/y`
（文本子件再加其 `RECT` 原点）。实测 AIR：非文本子件 `child.x == matrix.tx`（`vbitemskin c4 xy=41,23.75`）、
TextField 子件 `x = tx + RECT.xmin`（`staticskin c1 xy=9.25,55.7` ✓ 逐位相同）。缩放**必须**留在矩阵里：
F1 已实测 AIR 的九宫格不认 placement 拉伸（42 个被拉伸的 gridded entry 只有那样才对得上），
且 AIR 仍从矩阵读出 decomposed 值。像素不变（渲染合成 `T(x,y)·R·S·M`）。

**④ `width/height` 的精度对齐（`as_do_extents`）**

文本子件宽高走「角点映射」会带上子件自身 `y` 再减回去，实测 `staticskin` 的文本子件读成
`19.950000000000003`（AIR 正好 `19.95`）；现在轴对齐情形直接算 `(r-l)*a*scaleX` / `(b-t)*d*scaleY`
（旋转/斜切仍走角点映射），逐位等于 AIR。

**⑤ Shape 的包围盒 = 声明的 SWF `ShapeBounds`（`as_bounds_walk` 新增 `decl` 参数）**

实测：`#212`(adl `396.45×22.75`)、`#214`(`361.6×17.6`)、`#210`(`360×16`) —— 三者都**逐位等于 tag 里声明的
ShapeBounds**，而我们的**运行时路径点累积盒**在若干角色上会偏（`#212` 曾报 `374.7×1`：它是一组 74 条
hairline 斜线的排线，累积盒不稳）。因此 `as_bounds_walk` 增加第三个参数 `decl`：`decl && g->_clip` 时
直接取 `as_swc_clip` 记下的声明矩形（**不再叠加描边半宽** —— 声明矩形本身已含描边），递归（按钮态 /
容器）透传；**显示口径的调用点传 1**（`as_do_extents` / `as_do_width` / `as_do_height`、`getBounds`、
`hitTestObject`），**命中测试与 `getRect` 传 0**（AIR 按**绘制区域**拾取；`getRect` 保持既有「不含描边」口径）。
`temp/shbox.ts` 复核：378 个 shape 里「声明矩形」与「路径并集 + 描边」在 **116 个**上有差 ⇒ 声明矩形才是
权威并集（我们的路径累积盒还会把笔位 `moveTo` 也算进去）。`decl` 只喂 AS3 包围盒读口，**不参与光栅**。

**验收**：

- `temp/childfx/`（`cmp.py`，`TOL=1e-6`）：15 符号 / 99 子件 → **`x/y` 0 处、`numChildren` 0 处不符**；
  `width/height` 从 39 降到 35（证据 `temp/childfx/cmp_item2_final.txt`）。
- **残留 35 处**：33 处是**精度级**（`|Δ| ≤ 0.021px`，多数 ≤0.005：AIR 自己的包围盒量化/累积口径与我们不同，
  例 `playskin c0` `634.3×31` vs `634.3×30.975`、`userskin c4` `260×30` vs `260.0006×30.0001`、
  `homeskin c6` `354×580` vs `353.999×580.021`）；3 处源自 **morph 几何缺失**（`fileitemskin c2`
  `221.25×41.65` vs `128.35×19.55`、`元件124_72 c2` `11.75×11.75` vs `0×0`、`元件27_310 c0` `1×18` vs `0×0`）
  ⇒ 已记 §10。
- **1× harness 逐位不变**（`decl` 不参与光栅）：`temp/swc-render/rep_final.txt` 与修前 196 行逐 entry
  **0 差异**（`bitmap 3/1/1/1`、`display(无文本) 2/37/37/27`、`display(含文本) 0/90/120/23`、`params 200/200`、
  `ERR 0/0`）；唯一变化是**分桶**（见 §9.1 注）。
- `examples/swc-shape.as` 新增 **⑦** 结构断言（`staticskin numChildren==19`、`c1 is TextField && x==9.25 &&
  y==55.7 && width==79.4 && height==19.95`、`fileitemskin n==5 && c2 n==4 && c2 c1 is Shape`、
  `loginskin n==9 && c1 is Shape && c1.visible`、`popchatitem c0 scaleX==1 && scaleY==1 &&
  transform.matrix.a==1.497314453125 && .d==1.1999969482421875`）→ `swc-shape-ok`（纯结构，不依赖 Skia）。
- `node test.ts` = **147 passed / 0 failed**（exit 0），新增 2 条几何检查（声明盒分支 + 递归透传），
  并同步了 6 处 `as_bounds_walk` 签名断言。

**复现**：

```
# 子件树逐项对 adl（15 符号 / 99 子件）
cd temp/childfx && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && python3 cmp.py
# 声明矩形 vs 路径并集（378 个 shape 普查）
node temp/shbox.ts
# 结构回归
node src/index.ts examples/swc-shape.as --swc ../temp/skin.swc --run
# 1× 全量像素（须与 rep_final.txt 逐行相同）
cd temp/swc-render && node gen.ts && <ours> && ./run_adl.sh && VERBOSE=1 node compare.ts
```

---

### 9.2 F6 多帧时间轴烘焙 + `FrameLabel` + `MovieClip` 时间轴 API（阶段九十五·九，v0.4.68）

**背景**：此前 `DefineSprite` 只烘**第 1 帧**（`spriteChildren` 只读 `frameStarts[0]` 之前的记录），
`FrameLabel`(43) 与 `RemoveObject2`(5/28) **根本没解析**，于是 `MovieClip` 只能报「第 1 帧 + 自己数出来的
`totalFrames`」。本阶段把**逐帧关键帧差值**在编译期烘成静态表，运行期 `gotoAndStop`/`nextFrame`/
`prevFrame`/`currentLabels` 逐项对齐 `adl 51.4.1`。

**方法**：`temp/tlprobe/`（`gen.ts` 生成一份共享 body，两侧分别用 mxmlc+adl 与我们编译；`app.xml`
`<visible>true</visible>`、400×300，使 `ENTER_FRAME` 真的派发）。`cmp.py` 对 68 行 API 输出比对，
已知差异（子件 `name`、内建类名的 `flash.display::` 前缀）显式归一化后 ⇒ **0 处差异**。

**AIR 实测口径（`temp/tlprobe/adl.txt`，全部为 adl 直读）**

| 观测项 | `adl` 口径 |
|---|---|
| `totalFrames` | = SWF 的 `ShowFrame` 条数（`desktopshareitem` 21、`devicesitemskin` 23、`元件16_124` 17、`checkbom`/`toastbtn` 2、`元件172_339` 3） |
| 新建剪辑的初态 | `currentFrame == 1`、**`isPlaying == false`**，且在显示列表上**跨 12 帧也不自走**（离屏与上屏都一样）⇒ 皮肤符号的 `stop()` 在 DoABC 里，我们读不到；故**烘焙剪辑一律停在第 1 帧**（既不发明动画，也让像素 harness 逐位不变） |
| 属性名 | 是 **`isPlaying`**（没有 `playing`） |
| `currentLabel` / `currentFrameLabel` | 该帧的 `FrameLabel` 名，或 `null` |
| `currentLabels` | **`Array` of `FrameLabel`**（`{name, frame}`），与我们的解析逐条一致（如 `_up@1 _over@8 _down@15`） |
| `gotoAndStop(n\|label)` | **前进**：就地打增量（子件身份保持）；**后退或回到 1**：**重建**目标帧的对象（adl 复现出新的自动实例名 `instance5`） |
| `nextFrame` / `prevFrame` | 步进 + **回绕**（`totalFrames` 处回 1、1 处回 `totalFrames`） |

**实现**

- **解析**（`src/swc.ts`）：新增 `FrameLabel`(43)（`readSwfCString` → `SwcSprite.labels`）；**新增
  `RemoveObject`(5)/`RemoveObject2`(28)** → `charId: null, move: false` 的删除记录；`SwcPlacement` 增加
  `visibleFlag: boolean|null` 三态（`Visible=1` 必须**取消**隐藏，缺该字段则**不动**可见性）与 `ratio`。
- **烘焙**（`spriteFrames`，键 = Flash **深度**而非子件索引）：帧 1 建立 `depth → {charId, matrix}` 状态，
  逐帧推演：带字符 = 新增/替换（`replace: true`，继承记录省略的变换）、`Move` 且无字符 = 修改、无 `Move`
  且无字符 = **删除**、同帧同深度后写覆盖先写；**什么也没带的 op 直接丢掉**并计数报明（本库 270 条
  只带 morph `Ratio` 的记录）。`SwcBakeCharacter` 增加 `totalFrames`/`frames`/`labels`。
- **发射**（`src/emit.ts`）：`as_swc_tl_total/start/find/put/del/clear/apply` + `as_swc_tl_labelcount/
  labelat/frameat/label/labelframe`（静态 `switch (charId)`，标签名用 `strcmp`）；`MovieClip` 增加
  `play`/`stop`/`gotoAndPlay`/`gotoAndStop`/`nextFrame`/`prevFrame` 与 `isPlaying`/`currentLabel`/
  `currentFrameLabel`/`currentLabels`；新内建类 **`FrameLabel`**；时间轴子件带深度 `_tl_depth`
  （0 = 用户 `addChild` 的子件）以便「后退重建」只清时间轴子件。**无 bake 时全部发空桩**。
- **类身份顺带收窄**：多帧 sprite 现在实例化为 `MovieClip`（`as_swc_new` 的 sprite 分支），与 AIR 报的
  `flash.display::MovieClip` 一致（原先报 `Sprite`）。

**三个「绝不静默」的实测发现**

1. **`RemoveObject2` 原先被解析器静默丢弃**（17 条记录）。`toastbtn`(#634) 帧 2 = 「删深度 2 + 在深度 3
   放新字符」⇒ AIR 报 **3** 个子件（深度 1/3/4，美术换新），我们原先报 **4**。修后 `cmp.py` 归零。
   SWF 原始 17 条 `RemoveObject2` 里 9 条与「同帧同深度的重放」折叠成「新建对象」（不继承省略的变换）。
2. **标签名发射用了 UTF-16 字节转义**：`cStringLiteral` 是给**内嵌字节**用的（产出 `"\x0_\x0u\x0p"`），
   标签名用了它 ⇒ `FrameLabel.name` 全空、`currentLabel` 空，而 `currentLabels.length` 却**正确**
   （长度来自另一张表）。改用 `escapeCString` ⇒ `case 1: return "_over";`。**这条正说明要有 C 文本钉**：
   `test/unit/render.ts` 的 `unit: render/SwcTimeline` 直接钉住该行的字面形态。
3. **无 bake 时 `as_swc_bind` 没有定义**：`MovieClip` 的走表函数现在会调用它，于是**没有 SWC 的构建**
   （`examples/dyn-prop.as`、`stage62.as`、`stage94f.as`、`air-native/`）链接失败（阶段九十七 的验收里
   记录的正是这 4 个失败）。补一句 stub（`this.swcBake === undefined` 时发射）⇒ 4 个示例全绿。

**烘焙口径的数量（`temp/tlcheck.ts`）**：79 个多帧 sprite、其中 **75 个**帧 1 之后有变化、**448** 个 op 帧、
**514** 个 op（**102** 增/替、**404** 改、**8** 删）；**89** 条 `FrameLabel`（31 个 sprite）。

**验收**

- **API 逐项对齐**：`temp/tlprobe/` 68 行（`totalFrames`/`currentFrame`/`currentLabel`/`currentFrameLabel`/
  `nLabels`/子件数/子件类名/子件 `x/y`/`gotoAndStop(2)`/`gotoAndStop(label)`/`nextFrame`/`prevFrame`/`stop`/
  12 帧 × 4 个新建剪辑的 `isPlaying`）⇒ **0 差异**。其中 `checkbom` 帧 2 的文本子件 `x = 200/20 + RECT.xmin(-2)
  = 8`（AIR 实测 8）——**修改记录同样要套文本原点规则**。
- **子件树不回退**：`temp/childfx/` 15 符号 / 99 子件 ⇒ `x/y` **0** 处、`numChildren` **0** 处、
  `width/height` 仍 **35** 处（与 F5 相同）。
- **1× 像素 harness 逐位不变**：`temp/swc-render/rep_final.txt` 与修前 **196 行逐 entry 0 差异**
  （帧 1 起停 ⇒ 时间轴不参与光栅；`MovieClip_new()` 不改像素）。
- `examples/swc-shape.as` 新增 **⑧** 结构断言（`desktopshareitem totalFrames==21 / currentLabel=="_up" /
  !isPlaying / currentLabels.length==3 / [1] == _over@8`、`gotoAndStop("_down")→15`、`nextFrame/prevFrame`
  1↔2、`toastbtn` 帧 2 删记录后仍 3 个子件、`checkbom` 帧 2 文本 `x==8` 且回退回 `24`、`元件172_339`
  3 帧 1 子件）→ `swc-shape-ok`。
- `node test.ts` **全绿（exit 0）**，新增 `unit: render/SwcTimeline` **11 条钉**（标签表 / 替换继承 /
  文本原点 / 删记录 / 标签字面量 / `strcmp` 表 / `MovieClip_new`+`as_swc_tl_start` / `FrameLabel` 构造 /
  `isPlaying` / 无 bake 的 `as_swc_bind` stub）。

**残留（记 §10）**：① 时间轴子件的 `name` 恒 `null`（AIR 自动命名 `instanceN`，SWF 记录里没有 `Name` 字段）；
② **每帧 ActionScript（DoABC）不执行** ⇒ 剪辑恒停在第 1 帧；③ morph 时间轴的 `Ratio` 记录被丢弃（morph 是
空占位子件）；④ 子件 `x/y` 的**末位差**（`0.9500000000000002` vs `0.95`，≤2 ULP，来自两次 `/20` 相加）。

**复现**：

```
# 时间轴 API 逐项对 adl（68 行）
cd temp/tlprobe && node gen.ts && ../../src/index.ts ours.as --swc ../../temp/skin.swc --run && ./run_adl.sh && python3 cmp.py adl.txt ours.txt
# 烘焙口径与 op 计数
node temp/tlcheck.ts
# 子件树（15 符号 / 99 子件）
cd temp/childfx && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && python3 cmp.py
# 1× 全量像素（须与 rep_final.txt 逐行相同）
cd temp/swc-render && node gen.ts && <ours> && ./run_adl.sh && VERBOSE=1 node compare.ts
```

---

## 10. 明确延后 / 限制

| 项 | 原因 |
|----|------|
| 运行时解码的 ±1 通道漂移（半透明像素） | Skia `readPixels(kUnpremul)` 对 straight-alpha PNG 会做预乘→反预乘两次取整，使 A∈(0,255) 的像素 RGB 漂 ±1（alpha 逐位精确）。实测 388,648 像素中 206 个不符（0.053%），均在 §11③ 允许范围内。彻底消除需自带 PNG 解码器（绕开 Skia 的 alpha 变换），代价与收益不成比例。见 §5「保真」实测修正 |
| ~~`vbitemskin`(charId 293) 的一处遮挡差异（未定位）~~ **已定位并修复**（§9.2 F3） | 根因 = `PlaceObject3` 的 `Visible = 0`（depth 6 的 #286）被解析后丢弃 ⇒ AIR 隐藏、我们画出。修后该符号 `maxdcS 76 → 30`，同批 42 个 entry 全部变好（`fileitemdoctorskin` 205 → 2 等）。残留的 30 属抗锯齿/色彩级差 |
| ~~`PlaceObject3` 的 `FILTERLIST` / `BlendMode` / `BitmapCached` 三个属性解析后丢弃~~ **已实现**（§9.2 F4，v0.4.65） | 13 条滤镜（11 Glow + 2 DropShadow）、8 条 `BlendMode`（7=`layer`、1=`darken`）、2 条 `BitmapCached` 全部落地；含 `strength` 与模糊 σ 的 AIR 对齐。1× harness 逐符号一边倒变好、无一处变差 |
| 滤镜的 `inner`（内发光/内阴影）与 `knockout` | 两者都在 SWC 记录里解析出来并进了 AS3 滤镜对象，但**光栅路径未实现**：我们一律按外发光/外阴影画。实测 `temp/skin.swc` 的 13 条记录 `inner = 0`、`knockout = 0`，故当前无像素影响。Skia 侧要表达「内」需要额外构造（用剪影取反 + `Blend(kSrcIn)`），未做 |
| `FILTERLIST` 里的 Bevel / GradientGlow / Convolution / GradientBevel / ColorMatrix（FilterID 3–7） | 只按文档长度跳字节并进 `swcBake.notes`**报明**，不静默丢弃；实测本库 0 条。属于「遇到再实现」 |
| 模糊剖面：我们用的是**高斯近似**，AIR 是**真 box** | 已按方差匹配（`sigma = blur*sqrt(quality)/sqrt(12)`），中心/尾部仍不同（`blur6q1` ours 217/161/94/38/9 vs AIR 191/148/106/63/21）。求真 box 需 `MatrixConvolution`（每层 36~256 抽头、非可分离），性能风险大于收益 |
| `BlendMode` 中 Skia 无法表达的模式（subtract / invert / alpha / erase） | glue 返回 0（按 `kSrcOver` 处理）并由 `notes` **报明**，不做近似 —— 实测本库 8 条全在可表达集合内（`layer`/`darken`） |
| `BlendMode.LAYER` 的语义口径 | 实现为**纯分组隔离**（`saveLayer` + `kSrcOver`）。AIR 的 `layer` 还要求该对象成为独立缓存组（等价于 `cacheAsBitmap`），本库唯一一条 `layer` 场景像素无差异，故未叠加缓存 |
| ~~被跳过的字符类型让显示列表**子件数偏少**~~ **已修**（§9.2 F5，v0.4.66） | `DefineEditText`/`DefineText`(341) 烘为空 `TextField`、`DefineMorphShape`/`2`(6) 烘为空 `Shape`，`numChildren`/`getChildAt` 索引与 AIR 一致（`minfo` 6 vs 6、`fileitemskin` 5 vs 5、`staticskin` 19 vs 19）。**残留**：① 文本占位子件没有字形/初始文本，其 `width/height` 只按声明的 `RECT` 报（实测本库 341 个 `DefineEditText` 的 `AutoSize` 全为 0 ⇒ 与 AIR 无差）；② morph 占位子件没有几何 ⇒ 3 处 `width/height` 差（`fileitemskin c2` `221.25×41.65` vs `128.35×19.55`、`元件124_72 c2` `11.75×11.75` vs `0×0`、`元件27_310 c0` `1×18` vs `0×0`） |
| 子件的**类名身份**与 AIR 不同 | AIR 对 SymbolClass 链接过的字符报**类名**（如 `popbgskin`）、对 morph 报 `MorphShape`；我们统一按基类报 `Sprite`/`Shape`（`getQualifiedClassName` 可观测）。像素与树形不受影响 |
| AIR 的包围盒**量化/累积口径**与我们不同（未定案） | 实测 `temp/childfx/` 里 33 处 `width/height` 差 `\|Δ\| ≤ 0.021px`（多数 ≤0.005，且**两个方向都有**）：例如 `userskin c4` AIR `260×30` vs 我们 `260.0006×30.0001`（同一个 280×46 的矩形 × 同一个 16.16 矩阵 scale，AIR 的值看着像是它自己的内部取整）、`homeskin c6` `354×580` vs `353.999×580.021`。两个模型的差在 0.4 twip 以内，未定案。**另**：烘焙坐标自身也有末位差（时间轴探针里文本子件 `y = 0.9500000000000002` vs `adl 0.95`，≤2 ULP，成因是两次 `/20` 相加），同样只影响字符串打印 |
| ~~时间轴 placement 的矩阵不回填到子件**自己的** `x/y/scaleX/scaleY`~~ **`x/y` 已修**（§9.2 F5，v0.4.66） | 平移现在写进子件自身 `x/y`（实测 `vbitemskin c4` `41,23.75`、文本子件 `x = tx + RECT.xmin`，均逐位相同）。**刻意保留**：2×2（scale/rotation/skew）仍只在 `transform.matrix` 里 —— F1 实测 AIR 的九宫格**不认** placement 拉伸（42 个被拉伸的 gridded entry 只有那样才对得上），故 `child.scaleX/scaleY` 我们报 1、AIR 有时报 decomposed 值（如 `popchatitem c0` `1.4973`）。像素与 `transform.matrix` 读回一致，只有直接读 `child.scaleX` 的代码可观测 |
| `ZWS`(LZMA) SWC | `temp/skin.swc` 是 `CWS`；布局已在 §4 给出，实现成本低，但价值有限故延后 |
| 字体（`DefineFont*`） | 需分两条路看：**app.xml 的 `<embedFonts>` 路径 `air-app.ts` 已实现**（产出清单 `font-urls` / `preload-paths`）；**SWC 内嵌字体尚未处理**——实测 `temp/skin.swc` 含 **7 个 `DefineFont3`**，属「从 SWC 取字体」这一独立解码域 |
| 声音（`DefineSound`） | 实测 `temp/skin.swc` **无** `DefineSound`（0 个）；若将来遇到，是独立解码域 |
| 被 `Sprite` 引用的无类名位图（43 个） | 需解析 `DefineSprite`/`PlaceObject` 的完整显示树；**注意 `small_gift`/`checkbom` 属于这一档**（早期版本误列为 16 个之一） |
| `[Embed]` 元数据语法 | **不是「已有捷径」**：`Embed` 目前无任何语义层消费者（§1），自有项目场景同样需要实现 |
| `DefineBitsJPEG4`（tag 90） | 实测 `temp/skin.swc` 无；与 JPEG3 同族，随手支持即可。**注意**：`CHARACTER_TAG_KINDS` 已把它归为 `bitmap`，但提取器只处理 20/21/35/36 ⇒ 真遇到 tag 90 会在 `swcBakePlan` 的位图分支上以一句**误导性**的 `bitmap fill references missing bitmap #N` 失败（应按 JPEG4 报明） |
| ~~九宫格缩放（`DefineScalingGrid`，实测 22 个）~~ **已实现**（§9 F/§9.2 F1）；但 **AS3 侧的 `DisplayObject.scale9Grid` 属性尚未实现** | 工程只从 SWF tag 烘焙九宫格，运行时**没有**可读写的 `scale9Grid` 属性（AIR 有）。即：SWF 皮肤里的缩放不会糊，但用户代码无法自己设置/查询它。 已按 §1.5 记入 `TODO.md` 的 `### 遗留待开发` |
| `BitmapData.draw(source, matrix)` 对 source **自身变换**的处理与 AIR 不同 | 实测 `adl`：给被绘对象设 `o.scaleX = 2` 在 `draw(source, matrix)` 中**无效**（只受 `matrix` 参量影响）； 我们的实现会应用它。探针因此统一改为先包一层容器再 draw。**未定案**，记入 `### 遗留待开发` |
| 形变 shape（`DefineMorphShape`/`2`，实测 6 个） | 需两套几何 + 插值；本库仅 6 个，价值低故延后。**现状**：已烘成**空 `Shape` 占位子件**（§9.2 F5）⇒ 树形对齐、不画错像素，几何与插值仍是缺口；其时间轴的 `Ratio` 记录（本库 270 条）被丢弃并报明（§9.2 F6） |
| ~~按钮四态（`DefineButton2`，实测 29 个）~~ **已实现**（§9 F/§9.2 F2） | `ButtonRecord.states` 位掩码 + 绘制时状态机（`as_sbtn_state`）；离屏与 `adl` 逐像素一致 |
| ~~时间轴动画（`DefineSprite` 多帧 + `FrameLabel`）~~ **已实现**（§9.2 F6，v0.4.68） | 逐帧差值（增/替/改/删）在编译期烘焙，`gotoAndStop`/`nextFrame`/`prevFrame`/`currentLabels` 与 `adl` 逐项一致（68 行 0 差异）；79 个多帧 sprite / 514 个 op / 89 条 `FrameLabel`。**残留**：① 时间轴子件的 `name` 恒 `null`（AIR 自动命名 `instanceN`，SWF 记录里没有 `Name` 字段）；② **每帧 ActionScript（DoABC）不执行**—— 皮肤符号的 `stop()` 读不到，故烘焙剪辑**一律停在第 1 帧**（这正是 `adl` 的观测行为，像素 harness 因此逐位不变）；③ morph 时间轴的 `Ratio` 记录被丢弃（morph 是空占位子件） |
| **SWC 内嵌代码（ABC 字节码）** | **这是范围外，不是「延后」**：实测 255 个 `DoABC` = 254 类 / 54,162 B 字节码。容器读取已解（§3.3.1，255/255 round-trip 自证），但字节码→可编译产物需**反编译器或 AVM2 解释器**（§3.3.2），属另行立项。现实形态 =「资源取自 SWC，代码来自 `.as`」，并用 `<dep>` 做编译期诊断（§3.3.3）。**实测只有 mx/flex 8 个类（3,135 B）缺源码**，手写即可（§3.3.0） |

---

## 11. 附：实测方法与数据（可复现）

本节记录复核所用的方法，便于将来回归时对齐。

**① 无头解包审计**（不依赖任何第三方库）：

```
Node: zlib.inflateRawSync 解 ZIP 层 → zlib.inflateSync 解 CWS 层
      → 跳过 stage header（nbits 由 body[0]>>3 得到，头部 = ceil((5+4*nbits)/8) + 4 字节）
      → 逐 tag 扫描（length==0x3f 时读后续 UI32）
```

**② AIR 真值（`adl`）**：

```as3
// 用 mxmlc 把 SWC 链进来（-include-libraries+=skin.swc 才会嵌入资源）：
var bd:BitmapData = new logo(0, 0);           // 实参被忽略，得到 100x72
bd.getPixel32(x, y)                            // 逐点导出，与本地提取结果比对
```

注意事项（踩过的坑）：

- `-library-path+=` **不会嵌入**资源（生成的 SWF 只有 748 B）；必须用
  `-include-libraries+=`（SWF 变成 ~692 KB，资源才真正嵌入）。
- `adl` 的 `trace()` **不落到 stdout**（走 AIR debug log）。要拿数据请用
  `File`/`FileStream` 写到文件，并在末尾 `NativeApplication.nativeApplication.exit()`。
- 传应用描述符要**绝对路径**，并按项目惯例加 `-- <appDir>`。
- `mxmlc` 默认产出 **`ZWS`**；若要本地解析自造 SWF，按 §4 的 `ZWS` 布局解 LZMA。

**③ 关键实测数据汇总**：

| 项 | 值 |
|---|---|
| `skin.swc` | 743,520 B；ZIP 内 `catalog.xml`(5,570/84,463) + `library.swf`(737,700/737,552) |
| `library.swf` | `CWS`，version 44，body 1,031,069 B，tag 1,504 |
| 位图 tag | 59 = `DefineBitsLossless2`×53 + `DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2 |
| `SymbolClass` | 1 个 tag，214 条映射；映射到位图的 59 个中 **16 有类名 / 43 无类名** |
| `catalog.xml` | `<script>` 255 条（= 类数；`library.swf` 的 `DoABC` 也是 255 个） |
| 16 个命名资源 | `desktopicon`(342×194) `logo`(100×72) `imgback`(200×200) `cambitmap`(700×393, tag20) + 12 个 `com.vsdevelop.controls.scrollbar.*SkinClass[_200]` |
| 像素字节序 | `A,R,G,B`（7200/7200 首字节 == AIR alpha） |
| 预乘 | 是（340,644 样本：`R\|G\|B > A` 为 0；`A=0` 且 RGB 非零 为 0） |
| AIR 反预乘 | `floor(stored*255/A + t)`，`t ∈ [0.329, 0.413)`；`floor(x+1/3)` = 219/219 精确 |
| 嵌入代价（原始 ARGB → `0xNN,`） | 1,555,412 B 原始 → **7,777,060 B C 源码 ≈ 7.42 MB**（错误方案） |
| **嵌入代价（PNG 重编码，推荐）** | PNG 二进制 **14,569 B** → C 源码（`\xNN`）**43,723 B ≈ 42.7 KB**（**178×** 更小） |
| tag payload（对照） | 16 个资源在 SWC 内合计 **13,097 B** |
| 单资源例（`cambitmap` 700×393, tag20） | 原始 **1,100,400 B** → PNG **8,070 B** |
| `DoABC` | 255 个（tag 82）；ABC 容器共 **252,737 B** |
| ABC 内容 | 254 类 / 1429 方法 / 1316 方法体 / **54,162 B 字节码** / 字符串 **9,977** 实体（含保留槽的原始计数 10,232） / 最大单方法体 2,234 B |
| ABC 解析自证 | **255/255** 模块 round-trip 精确吻合（精确消耗至末字节） |
| ABC 类别拆分（互斥） | 位图资源 16（152 B）/ `extends MovieClip` 192（5,489 B，其中 `skin_fla.*` 89）/ 接口 6（6 B）/ mx/flex 8（3,135 B）/ 其余逻辑 37（32,465 B） = 254 类、**41,242 B**；+ 未归属 12,920 B = 54,162 B |
| 缺源码的类 | **仅 mx/flex 8 个（3,135 B）**，其中 5 个是空接口（各 1 B） |
| 模块级字节码 top | `StringCore` 4,373 / `DownLoader` 3,576 / `TweenLite` 2,799 / `MD5` 2,616 / `mx.core.BitmapAsset` 2,515 / `JSONTokenizer` 2,480 / `MHIOSScrollBar` 2,333 / `MWIOSScrollBar` 2,195 / `ComBoBox` 1,557 |

**④ ABC（`DoABC`）审计**（§3.3 的数据来源）：

```
按 §4 的无头解包拿到 SWF body → 逐 tag 扫描，收集 tag 82（DoABC）：
  payload = u32 flags + 空结尾 cstring moduleName + ABC
再按 §3.3.1 的段序解析 ABC，统计 classes/methods/bodies/字节码总量。
```

**自证方法**：解析器必须对每个模块「**精确消耗到最后一个字节**」（round-trip），
**255/255 全中才认为段序正确**——这是唯一能证明「没静默错位」的判据（错误顺序也会
「能跑完」，只是后面字段全变成垃圾，肉眼很难发现）。

坑（均已在 §3.3.1 列出）：metadata 表在 kind 载荷**之后**（读反是最隐蔽的错位源）；
`HAS_OPTIONAL` 项是 `value u30 + kind u8`；`HAS_PARAM_NAMES` 读 `param_count` 个（不是 `param_count+1`）；
池类计数含保留槽 0、而 method/class/script/method_body/metadata 为精确值；
**`class_info` 向量无计数前缀**（长度 = `instance_count`）；**池类索引 0 是保留槽**，查名要取 `pool[idx-1]`。

本次再审又踩中三条（已并入 §3.3.1），可见「把容器读对」确实需要自证而不能靠肉眼：
① 把 `class_info` 当普通向量多读一个 u30 → 全盘错位；
② 忘了 `pool[idx-1]` → 名字全变垃圾（但**不报错**，只靠 round-trip 才看得出）；
③ 按类聚合字节码时用了**全模块共享的 method 索引表**，而 method 索引是**每模块各自编号**的，
   跨模块会碰撞→数字虚高一倍——这也是为何 §3.3.0 的类级字节码必须**按模块**聚合。

权威参照：Ruffle `swf/src/avm2/read.rs` 的 `read_trait` / `read_method` / `read_constant_pool`
（Rust，**只作格式基准，不引入代码**）。若将来实现，建议直接照它的段序写，并保留 §3.3.1 的自证判据。

**⑤ 矢量 shape / 显示树审计**（§3.4 的数据来源）：

```
解出 SWF body → 跳过 stage header → 递归扫 tag（进入 tag 39 的 payload[4:]）：
  DefineShape(2)/2(22)/3(32)/4(83) → 按 Ruffle 段序解析 SHAPEWITHSTYLE + 逐条 shape record
                                   （FillStyleArray/LineStyleArray/NumFillBits/NumLineBits → 位流）
  PlaceObject(1)/2(26)/3(70)       → 取被摆放的 character id
  SymbolClass(76)                  → id → 类名
  DefineSprite(39)                 → 递归
```

**自证**：每个 shape 必须**精确消耗到 payload 末尾**（剩余 < 8 bit）——本库 **378/378** 全中。
引用图另用「被摆放的 id 是否命中已知字符」交叉校验，**978/978** 全中。

坑（均已并入 §3.4⑤）：`LINESTYLE2` flags 是 **MSB-first**（当小端 `u16` 读会漂移 5 个 v4 shape）；
`PlaceObject2` flags 是 **LSB-first**（`HasCharacter=0x02`）；每个 sprite 末尾有**长度为 0** 的
`PlaceObject`（`40 00`），不设护栏会引入 `id=0` 垃圾引用；`DefineEditText`（337 个）也是字符，
漏登记会让引用图凭空出现 336 个「未知 id」。

权威参照：Ruffle `swf/src/read.rs` 的 `read_define_shape` / `read_fill_style` / `read_shape_record`
（只作格式基准，不引入代码）。

**矢量 / 显示树实测汇总**：

| 项 | 值 |
|---|---|
| `DefineShape` | **378**（v1 186 / v2 50 / v3 56 / v4 86），payload **29,774 B** |
| 边 / 子路径 | 5,052（直线 3,059 / 二次 1,993）/ 905 `moveTo`，样式切换 998 |
| 填充 401 | 实色 326 / 位图 73 / 线性 2 / 径向·焦点 0 |
| 描边 / 多填充 | 86 条（80 个 shape 有描边）；43 个 shape 有多个填充 |
| v4 标志 | `UsesScalingStrokes` 84 / `UsesNonScalingStrokes` 1 / `UsesFillWindingRule` **0** |
| 建路径调用 → C | 5,957 → 约 **233 KB**；导出闭包 4,181 → 约 **194 KB** |
| 导出符号 | 214 = sprite 196 / bitmap 16 / button 2；**shape 0** |
| 显示树 | `DefineSprite` 333；`PlaceObject` 1,479 + `PlaceObject2` 1,935 + `PlaceObject3` 64；九宫格 22 |
| 其他字符 | `DefineEditText` 337、`DefineText` 3、`DefineMorphShape` 4+2、`DefineButton2` 29 |
| 引用图自证 | 被摆放 id 命中已知字符 **978/978**；shape 精确 round-trip **378/378** |

**未决项（留给实现阶段）**：`t` 的精确值只能由更多 `(alpha, 存储值)` 组合进一步收窄
（本样本中 frac ∈ (0.5874, 0.6709) 的区间没有观测点，故 t 在该带内任取都对得上）。
实用上取 `1/3` 即可；若要求与 AIR 逐通道完全一致，需构造覆盖该分数带的合成资源再测。