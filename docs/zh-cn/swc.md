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
> **本次复核改正了早期版本的六处错误，阅读时请以本页为准**：
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
> 不是「需新增」（见 §5、§7）。
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
  是 §3.2 算出的 AIR 读回值。运行时解码拿到的就是同一组 straight ARGB，`getPixel32` 逐点对齐。
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

## 9. 分阶段计划（**编号待定**）

> **本节的阶段编号已作废**：早期草案占用了「阶段六十六 / 六十七 / 六十八」，这三个编号已被
> **其他已完成功能**使用——六十六 = `Vector.<T>` 高阶/序列方法（v0.3.69）、六十七 = 三子系统
> deferred 收尾（v0.3.70）、六十八 = `--package xcode-project` 工程生成器（v0.3.71）。
> 照原文阅读会误以为 SWC 已实现。**实现启动时再向 `TODO.md` 申请新编号**。

- [ ] **A. `src/swc.ts` 提取器（编译期）**：ZIP central directory 解析 → `library.swf` ZIP 层 raw-inflate
      → CWS `inflateSync`（ZWS 按 §4 布局）→ 跳过 stage header → 扫 tag；提取
      `DefineBitsLossless2`(tag 36)/`Lossless`(tag 20，补 `A=0xFF`)/`DefineBitsJPEG2/3`；
      **按 §3.2 做反预乘**，再**重编码为 PNG**（JPEG 标签则保留原字节）；解析 `SymbolClass`(76) 的
      `{id → className}`。产出 `SwcResource[]`（`className`/`format`/`width`/`height`/**`encoded` 字节**）。
      含一个约 100 行、零依赖的 PNG 编码器（Node `zlib`，见 §5.1）
- [ ] **B. 资源类注册 + 嵌入字节填充（codegen）**：`symbols.ts` 注册为 `BitmapData` 子类；
      `emit.ts` 发射资源段（§5.1，**默认内嵌同一 `.c`**）+ `new`/`getDefinitionByName` 两条分发路径，
      工厂内走**已存在的** `as_skia_image_decode_bytes_argb` 解码（§5、§7，**不新增运行时 API**）
- [ ] **C. CLI / 清单接入 + 收尾**：`--swc`（可多个）+ 清单 `swc-paths`；回归全部旧示例；
      README 同步限制；版本号递增
- [ ] **D. 早期诊断（小、但建议随首期一起做）**：读 `catalog.xml` 的 `<script>/<dep>`，对「引用了
      只以 ABC 字节码存在于 SWC 的类」给出编译期报错（§3.3.3）。**不反编译任何东西**，只做名字层面的
      集合运算。它是「用户代码引用了 SWC-only 类」这个必然场景的兜底，成本极小

**验收基线（可直接复用本次复核的数据）**：对 `temp/skin.swc` 跑提取器，
① 16 个命名资源全部提取；② `logo` 为 100×72 且为**反预乘后**的值（先解出 straight ARGB，再编码成 PNG）；
③ **与 `adl` 的 `getPixel32` 逐点比对**（§11 的方法），允许 ±1 通道偏差；
④ 体积：16 个资源的编码字节合计 ≈ **14.6 KB**（PNG），C 源码 ≈ **43 KB**（而非 7.42 MB）；

---

## 10. 明确延后 / 限制

| 项 | 原因 |
|----|------|
| `ZWS`(LZMA) SWC | `temp/skin.swc` 是 `CWS`；布局已在 §4 给出，实现成本低，但价值有限故延后 |
| 字体（`DefineFont*`） | 需分两条路看：**app.xml 的 `<embedFonts>` 路径 `air-app.ts` 已实现**（产出清单 `font-urls` / `preload-paths`）；**SWC 内嵌字体尚未处理**——实测 `temp/skin.swc` 含 **7 个 `DefineFont3`**，属「从 SWC 取字体」这一独立解码域 |
| 声音（`DefineSound`） | 实测 `temp/skin.swc` **无** `DefineSound`（0 个）；若将来遇到，是独立解码域 |
| 被 `Sprite` 引用的无类名位图（43 个） | 需解析 `DefineSprite`/`PlaceObject` 的完整显示树；**注意 `small_gift`/`checkbom` 属于这一档**（早期版本误列为 16 个之一） |
| `[Embed]` 元数据语法 | **不是「已有捷径」**：`Embed` 目前无任何语义层消费者（§1），自有项目场景同样需要实现 |
| `DefineBitsJPEG4`（tag 90） | 实测 `temp/skin.swc` 无；与 JPEG3 同族，随手支持即可 |
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
| 预乘 | 是（340,644 样本：`R|G|B > A` 为 0；`A=0` 且 RGB 非零 为 0） |
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

**未决项（留给实现阶段）**：`t` 的精确值只能由更多 `(alpha, 存储值)` 组合进一步收窄
（本样本中 frac ∈ (0.5874, 0.6709) 的区间没有观测点，故 t 在该带内任取都对得上）。
实用上取 `1/3` 即可；若要求与 AIR 逐通道完全一致，需构造覆盖该分数带的合成资源再测。