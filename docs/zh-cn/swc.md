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
> 本文的技术结论均基于对真实 `skin.swc` 的**解包实测**，并以 AIR SDK 的 `adl` 取 `getPixel32`
> 真值交叉验证（方法见 §11）。**夹具换过一次代**：早期章节的实测取自旧导出（仓库根的 `temp/skin.swc`，
> 743,520 B / 255 个类 / 59 个位图资源，**该文件已不在仓库**），下文凡标「旧导出」的数字都指它；
> **当前随仓库入库的是 `examples/embed-assets/skin.swc`**（454,007 B，md5 `f644237c…`，35 个导出符号、
> 15 个位图 tag），对它的逐项实测见 §0.1。机制结论两者一致，但**清单类数字不可跨夹具套用**。

### 0.1 当前入库夹具实测摘要（`examples/embed-assets/skin.swc`）

> 本节数字全部由 `temp/skinaudit.mts` 对仓库里那个 `.swc` 现测（探针自锁 md5，换文件即报错），
> 是全文唯一「随夹具走」的清单来源；下文各章的旧导出实测值保留原样并逐处标注。

| 项 | 值 |
|---|---|
| 文件 | `examples/embed-assets/skin.swc`，**454,007 B**，md5 `f644237cfa1559d81c3b84786fb0d204` |
| ZIP 条目 | `catalog.xml`(9,457 B) + `library.swf`(452,958 B)；后者是 **CWS**，`declared length` 505,130，解压后 body **505,122 B** |
| stage header | `nbits=15` → RECT 9 B + `frameRate`/`frameCount` = **13 B**（24 fps / 12 帧） |
| 导出符号 | **35**（`catalog.xml` scripts × `SymbolClass` × `DoABC` 三者一致）：**34 个符号类 + 1 个位图资源类 `desktopicon`**；本次导出的 `SymbolClass` **不含 `#0`**（文档类条目），所以不会踩到「导出字符无定义」那条报错 |
| 位图资源 | **15 个 tag**（`DefineBitsLossless2`×13 + `DefineBitsJPEG3`×2），其中**只有 1 个是命名资源类 `desktopicon`(342×194)**，其余 14 个是无名内嵌位图（`DefineBitsLossless` tag 20 **一个都没有**） |
| shape | `DefineShape`×54 + `DefineShape2`×10 + `DefineShape3`×4 + `DefineShape4`×22 = **90 个字符**；另有 `DefineMorphShape`×1（烘焙为真实几何 + `Ratio` 插值，§3.4⑦） |
| 影片剪辑 | `DefineSprite`×**66**（其中 **21 个是多帧**）、`DefineButton2`×4、`DefineScalingGrid`×5（九宫格） |
| 文本 | `DefineEditText`×56（带 InitialText，烘成 `TextField`）+ `DefineText`×2（字形需内嵌字体的 CodeTable，烘成空框）；`DefineFont3`×5 |
| 时间轴 | `FrameLabel`×36（其中 11 个多帧剪辑带 `_up/_over/_down`）、`PlaceObject2`×403 + `PlaceObject3`×18、`RemoveObject2`×4 |

---

## 1. 为什么这个需求存在：纯 AS 项目里 SWC 是资源载体

在 Flash/Flex 生态里，资源（皮肤位图、图标、字体）有两种归属：

| 场景 | 资源存放 | 提取难度 | 当前编译器状态 |
|------|---------|---------|---------------|
| 自有项目 + `[Embed(source="a.png")]` | 原图还在源码目录 | 低——直接读原图，**不用碰 SWC** | **同样未实现**：`parser.ts` 只做通用元数据解析（`parseMetadataIfPresent`），`Embed` 没有任何语义层消费者；`src/` 内除注释与 `EmbedFont`（app.xml 字体）外无 Embed 处理 |
| 第三方库 / Flash IDE 导出的皮肤库 | 原图不可得，只有 `.swc` | 高——必须解 SWC + 解 SWF | 本方案覆盖 |

用户场景是后者：`examples/embed-assets/skin.swc` 是一个 Flash IDE 导出的 UI 皮肤库（**旧导出**含 `logo`/`imgback`/`cambitmap` 等 12 个滚动条皮肤 + 4 个自有资源类；**当前夹具**只剩 `desktopicon` 一个位图资源类 + 34 个显示对象符号），原图已丢失，只能从 SWC 里提取。

> 两条路都要写代码，不要把第一行当成「已有捷径」——它的优势仅在**不需要解析 SWF**。

---

## 2. SWC 的解剖：ZIP 外壳 + 内嵌 SWF

把 `.swc` 后缀改成 `.zip` 解压，标准结构只有两个文件（`docs/` 是可选的 ASDoc 文档）：

```
skin.swc (ZIP 归档)
├── catalog.xml     84,463 B（未压缩）/ 5,570 B（deflate 后）—— 组件目录：<script> 列出每个类及其依赖（<dep>）
└── library.swf    737,552 B（未压缩）/ 737,700 B（deflate 后）—— 编译产物：SWF 容器（CWS = zlib 压缩）
```

`catalog.xml` 的结构（实测 `examples/embed-assets/skin.swc`）：

```xml
<swc xmlns="http://www.adobe.com/swccatalog/9">
  <libraries>
    <library path="library.swf">
      <script name="logo" mod="..." signatureChecksum="...">      <!-- 旧导出片段 -->
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
实测旧导出的 `library.swf` 是 **CWS**（解压后 body = 1,031,069 B）；当前夹具同样是 CWS（解压后
**505,122 B**，见 §0.1）。解压后是 tag 流，
每个 tag 由 `(code:length) 头 + 数据体` 组成。

> **重要**：扫描 tag 流前必须先跳过 SWF 的 stage header——`RECT`（`nbits` 以 5 bit 起始，共
> `5+4*nbits` bit）+ `frameRate`(UI16) + `frameCount`(UI16)。旧导出实测 `nbits=17`（头部 14 字节），
> **当前夹具是 `nbits=15` → 13 字节**，所以头部长度不能写死，必须按 `ceil((5+4*nbits)/8) + 4` 算。
> 早期实现若从 body 偏移 0 开始扫，会得到一堆无意义的 tag code（很容易误判为「没有位图」）。

资源相关的 tag（实测 tag 类型分布）：

| `[Embed]` 类型 / 资源 | SWF tag | tag code | 数据体内容 |
|---|---|---|---|
| PNG/无损位图 | `DefineBitsLossless` | 20 | SWF 自有位图格式，**无 alpha**（见 §3.1） |
| PNG/无损位图（带 alpha） | `DefineBitsLossless2` | 36 | SWF 自有位图格式，**有 alpha**（见 §3.1） |
| JPEG | `DefineBitsJPEG2` | 21 | `characterID` + **完整 JPEG 字节**（`FF D8` 开头） |
| JPEG（带 alpha） | `DefineBitsJPEG3` | 35 | `characterID` + `alphaDataOffset` + JPEG 字节 + **独立 zlib alpha 平面**（见 §3.2③） |
| JPEG4（带 alpha） | `DefineBitsJPEG4` | 90 | 与 35 同族，实测本库无；**未支持**（见 §10） |
| 原始字节 | `DefineBinaryData` | 87 | `characterID` + 原始字节 |
| 字体 / 声音 | `DefineFont*` / `DefineSound` | 10/48/14/75 | 字体/音频数据 |
| **symbol → 类名** | `SymbolClass` | 76 | `{id → "类名"}` 映射 |
| 时间轴影片剪辑 | `DefineSprite` | 39 | 显示树（`PlaceObject` 子对象） |

实测旧导出的 `library.swf` 有 **59 个位图 tag**（`DefineBitsLossless2`×53 +
`DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2），`SymbolClass` 里 **214 条映射**；
另有 `DefineSprite`×333、`DefineShape*`×378、`DefineButton2`×29、**`DefineFont3`×7**；
其中两个 `DefineBitsJPEG3`（`#1113` 186×160、`#1118` 167×162）正是 TalkMED 首页两张卡片的插画，
其 alpha 平面必须合成（§3.2③）。

**当前入库夹具要小得多**（§0.1）：**15 个位图 tag**（`DefineBitsLossless2`×13 + `DefineBitsJPEG3`×2，
**没有 tag 20 / tag 21**）、`SymbolClass` **35 条映射**、`DefineSprite`×66、
`DefineShape`×54 + `DefineShape2`×10 + `DefineShape3`×4 + `DefineShape4`×22（共 90 个 shape 字符）、
**`DefineButton2`×4**、`DefineFont3`×5。也就是说：**位图数量、tag 组合、命名资源表都换了**，
但「哪些 tag 必须处理」这个机制结论不变（两张 JPEG3 图分别 186×160 与 167×162 的旧样本，
在当前夹具里换成 #156 186×160 与 #165 167×162——尺寸一致、字符号不同）。

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

实测（**旧导出**）提取 `symbol#2`（`logo`）：`characterID=2, format=5, 100×72`，解压后像素
`28800 字节 = 100×72×4`，前 16 字节全 0（透明边缘），非零像素占 37.1%——是有效图片内容。
当前夹具的等价样本是 `#1 desktopicon`（`format=5`，342×194，`265,392 B = 342×194×4`）；
下面那些「数字»换成新样本也一样成立。

**tag 20 与 tag 36 不能混为一谈**：两者数据体布局几乎相同，但 **tag 20 的 format 5 是 24-bit RGB
（XRGB，第 1 字节是填充位，没有 alpha 语义）**，而 tag 36 的 format 5 才是真正的 ARGB。
把 tag 20 的第 1 字节当 alpha 用，在填充位为 `0x00` 的产物上会整张变全透明。实测（**旧导出**）
当时那份 `skin.swc` 里唯一一个 tag 20 恰好是**最大的资源** `cambitmap`（700×393，1,100,400 B 像素，
填充位恰为 `0xFF`，所以碰巧能显示正确——这种「碰巧」正是要避免的）；**当前夹具干脆一个 tag 20 都没有**
（15 个位图全是 tag 36/35），所以这条陷阱只能靠旧导出样本回归。

**结论**：`DefineBitsLossless*` 需要「解 zlib → 得到原始像素」，**不能**直接喂 Skia 的
`MakeFromEncoded`（它只认 PNG/JPEG 等编码格式）。而 `DefineBitsJPEG2` 存的**就是完整 JPEG**，
可直接喂 Skia。

### 3.2 像素格式契约（本节为 2026-09-26 复核新增，是唯一会导致可见错误的遗漏）

原始位图的像素有两条必须先讲清的性质：**字节序**与**是否预乘**。两条都已用 `adl` 取真值定案。

**① 字节序 = `A, R, G, B`（第 1 字节是 alpha）**——7,200/7,200 像素逐一验证（**旧导出**的 100×72
`logo`，与 `logo.getPixel32()` 的 alpha 通道**完全相等**，无一例外；当前夹具同一路径由 `desktopicon`
在 `examples/swc-bitmap.as` 里钉住具体像素，见 §9.1 验收基线②）。

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

**③ `DefineBitsJPEG3`(35) 的 alpha 是「**独立的 zlib 平面**」，必须与 JPEG 合成**
（2026-10-15 新增，diff doc **D25**）。

JPEG 本身没有 alpha 通道，所以 tag 35 把同一张图存了**两份**：

```
DefineBitsJPEG3 (tag 35) 数据体：
  characterID     u16
  alphaDataOffset u32                    ← 后面 JPEG 字节的长度
  JPEG 字节       (alphaDataOffset B)     —— **不透明**，透明处是 FLA 导出时填的**黑**
  alpha 平面      (tag 剩余字节)          —— **zlib 压缩**，宽×高 个字节，行主序、**无行填充**
```

AIR 把两者合成；若只把 JPEG 喂给 Skia，透明区域会画成**黑色矩形**（实测 TalkMED 首页两张卡片
`#1113` 186×160 / `#1118` 167×162：JPEG 四角恰为 `(0,0,0)`，平面上四角为 `0`、中心 `255`）。

**正确做法**：**编译期解压平面**（`node:zlib` 现成），**运行时合成**——运行时有 Skia 的 JPEG
解码器，而 Node 侧不引入 JPEG 解码器（AGENTS.md §3.1 零依赖）。生成 C 里两个平面各是一个数组，
由 `as_argb_apply_alpha` 合成：

```c
/* 直通 0xAARRGGBB 上叠一层 8 位覆盖度（tag 35 的 alpha 平面）。
   JPEG 恒解成不透明，故乘法既保住它自带的 alpha，又取到平面的值。 */
static void as_argb_apply_alpha(unsigned* p, int n, const unsigned char* alpha) {
  for (int i = 0; i < n; i++) {
    unsigned c = p[i];
    unsigned a = ((((c >> 24) & 0xffu) * (unsigned)alpha[i]) + 127u) / 255u;
    p[i] = (a << 24) | (c & 0x00ffffffu);
  }
}
```

运行时有**两条**路要走它：位图**子件 / 资源类**（`BitmapData_adoptEncodedAlpha`，合成后同时更新
`pixels` 与 `bd->image`）与**位图填充**（`as_swc_image_alpha`，填充 shader 采样的是 SkImage）。
**没有平面**时两条路都退回原样（`BitmapData_adoptEncoded` / `as_skia_image_from_bytes`），
保留 Skia 的惰性解码。

> **不许静默降级**：平面为空、坏流、或解不出 `宽×高` 字节时，`swc.ts` **响亮告警**并把
> `SwcBitmap.alpha` 记 `null` ⇒ 退回「只喂 JPEG」的行为，绝不拿垃圾覆盖度去合成。
> 钉 `unit: render/SwcJpeg3Alpha`（14 钉，合成与退回两条都钉住）。

### 3.3 另一类 tag：代码（`DoABC` / ABC 字节码）——**这是范围声明，不是「延后」**

`library.swf` 里除了位图资源，还有 **255 个 `DoABC`（tag 82）**，它们是 **254 个类的真实 AVM2
字节码**，不是空壳占位。实测（自写解析器对 **255/255** 模块 round-trip 精确吻合，方法见 §11）：

> **它现在真的挡路（实机证据，2026-10-14）**：皮肤符号自己的**时间轴脚本**也在 `DoABC` 里。真应用
> talkmed-meeting 登录页的用户协议开关 `agreebtn`，**没有任何 AS3 代码**去改它 —— 应用只**读**
> `agreebtn.currentFrame != 3`（`SmsAccount.as:270` / `TalkMEDAccount.as:129`），勾选动作在符号脚本内；
> 我们不执行 ⇒ `currentFrame` 永远停在第 1 帧 ⇒ 开关**点不动**、按「登录」必弹「请了解并阅读隐私政策和服务协议」，
> **登录流程到此为止**。双端对照：`adl 51.4.1` 点一下即变绿勾，AOT 版连点 4 次无变化。
> 详见 `as3compiler/talkmed-meeting-aot-vs-adl-diff.md` §2 D17 与 `TODO.md` 的遗留行。

**2026-10-14 收口（阶段一百五十六）：帧脚本这一半已落地，「范围声明」收窄为「真逻辑不执行、帧脚本执行」。**
新增 `src/abc.ts`（`parseAbc` / `decodeSymbolScripts` / `OPCODES` / `decodeCode`）在**编译期**把**符号类**的
帧脚本（`frame1`/`frame2`… 那一族方法）解成 AST、复用现有发射器：`this.stop()`、属性赋值、
`addEventListener` + 闭包 `_self`、`if/else` 三元、Flash 构造器形状的 `addFrameScript`
（**`callproperty` + `pop`** —— 只认 `callpropvoid` 会漏掉一半帧脚本）都在覆盖内。落点：`SwcCharacterClass.frames`
→ `as_swc_frames(charId, frame, o)`，由**构造器（第 1 帧）**与 **`as_mc_goto`（后续帧）**两个入口驱动；
`as_swc_new` 让被导出的嵌套符号实例化**自己的符号类**（帧脚本要类方法，裸 `MovieClip_new()` 没有）。
**边界照旧**：255 个模块里那 **254 个类的一般方法**（TweenLite / StringCore / DownLoader…）**仍然不执行** ——
那需要整个 AVM2；不支持的字节码形态一律**响亮报明/跳过**，不静默。实测：`skin.swc` 的 255 个 ABC 块
`aligned: 255 bad: 0`，解出 **100 个符号类 / 110 段帧脚本 / 138 个方法**；
回归钉在 `unit: render/swctimeline`（5 条，钉在发射出的 C 上，已验证能变红）。

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
| （**下表整体是旧导出的 ABC 画像**）位图资源类（`extends BitmapData`×4 / `BitmapAsset`×12） | 16 | **152 B** | 内容=位图，类只是 9–11 B 构造器 | 需从 SWC 合成（§5） |
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

**① 实测 tag 画像**（递归扫进 `DefineSprite`；`examples/embed-assets/skin.swc`）：

| tag | 数量 | 说明 |
|---|---|---|
| `DefineShape`/`2`/`3`/`4` (2/22/32/83) | 186 / 50 / 56 / 86 = **378** | 矢量 shape，payload 合计 **29,774 B** |
| `DefineSprite` (39) | 333 | 皮肤符号的时间轴容器 |
| `PlaceObject`(1) / `PlaceObject2`(26) / `PlaceObject3`(70) | 1,479 / 1,935 / 64 | 时间轴摆放记录 |
| `DefineScalingGrid` (78) | 22 | **九宫格缩放**（`scale9Grid`），皮肤拉伸要按它切 |
| `DefineButton2` (34) | 29 | 按钮四态 |
| `DefineMorphShape`/`2` (46/84) | 4 / 2 | 形变 shape |
| `DefineEditText`(37) / `DefineText`/`2`(11/33) | 337 / 3 | 文本字段（**tag 37 自阶段一百四十九起全量解码**，见 §10） |
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

#### 3.4⑦ `DefineMorphShape`/`2`（morph）：两套几何 + `Ratio` 插值（阶段三百一十七，v0.4.278）

morph 就是「同一条矢量在两端之间的线性插值」。SWF 规范要求两套几何的点与曲线**逐点对应**，
所以它天然是逐点 `lerp`，不需要任何形状匹配算法。本库只有 6 个（tag 46 ×4、tag 84 ×2），
但**界面就在它上面**：`skin_fla.元件77_50` 的一个 morph 有 98 条 `Ratio` 记录（帧 2..99，
662 … 64874），字幕条（#190 `aisubtitlesetup`）与文件行高亮（#384 `fileitemskin`）同理。

**① 二进制布局**（`temp/morph/probe.cjs` 逐字节往返、6/6 全中）

| 段 | 内容 |
|---|---|
| `CharacterId` | `UI16` |
| `StartBounds` / `EndBounds` | 各 4×`RECT`（twips） |
| （仅 tag 84） | `StartEdgeBounds` + `EndEdgeBounds` + `UI32 flags` |
| （仅 tag 84） | `UI32 OffsetToEndEdges`——**从本字段之后起算**，基准 = `(位流位置>>3) + 4`（#113: 31 + 98 = 129）。按「从 tag 头起算」解会整体错位，而且**恰好**能读出看似合理的垃圾 |
| 样式表 | `MORPHFILLSTYLEARRAY` + `MORPHLINESTYLEARRAY`：每个条目是 **start/end 成对**（索引 0 = 无样式） |
| 起始几何 | `NumFillBits`/`NumLineBits`（各 4 bit，打包成 `fillBits<<4 \| lineBits`）+ 记录的连续位流 |
| 分界 | `EndShapeRecords` 前的**字节对齐**，之后是结束几何的位流 |

实测踩过的三个坑：① 渐变填充的**每个 stop** 是四个字段（ratio + color + …），不是「一个 flags
字节 + 共享」；② `LINESTYLE2` 的 16 位 flags 是 **MSB-first**（与 §3.4⑤ 同一条）；③
`axisAligned = !readUB(1)`。

**② 解析自证（不成立就抛，不许静默）**

`parseSwfMorph` 除逐点配对（`start.xE/yE` 与 `start.x/y` 必须成对，`cxE/cyE` 与 `cx/cy`
同现同缺，不一致直接抛）外还有两道**结构**自检：`endHeadByte` 必须等于
`OffsetToEndEdges` 推出的头尾位置；结束几何读完后**剩余位 ∈ [0, 7]**（即恰好字节对齐）。
本库 6/6 通过；任一不成立说明段序读错了，宁可抛也不要产出错位的几何。

**③ 烘焙（`swc.ts` 的 `SwcBakeMorph`）**

- 两端几何各成为一组路径，**逐坐标成对存**，emit 期只做插值——配对工作全部留在解析期。
- `bounds` = 两端的**并集**（光栅裁剪用）；`decl` = **`StartBounds`**（显示盒用）。两者必须分开，
  理由见 ⑤。
- `PlaceObject2` 的 `Ratio` 记录**单独即可**产生一条 frame op（它可以不带字符、不带矩阵），
  所以 `SwcBakeFrameOp.ratio` 与 `SwcBakePlacement.ratio` 是两个独立字段。

**④ 发射（`emit.ts`）**

`as_swc_morph_<id>(Graphics* g, double t)`：`as_swc_fill_rule` → `as_swc_clip(并集)` →
`as_swc_morph_decl(起始盒)` → 逐 group 绘制；每个坐标 `as_swc_lerp(start, end, t)`，两端相同的
坐标保持常量（不插值）。填充/描边的**跨端一致性**（type、渐变种类/spread/interpolation、stop 数、
位图 id、线帽/连接/斜接比）在 emit 期校验，不一致直接抛——那是解析 bug，不是可降级项。
`as_swc_morph_ratio(o, build, ratio)` 钳 0..65535 → `Graphics_clear` → 重建。

**⑤ AIR 契约（adl 51.4.1 实测，`temp/morph/adl/`）**

- `MorphShape` 的 `width` / `height` / `getBounds` / `getRect` **不随 ratio 变**，恒等于
  **ratio 0 的起始盒**（#70：`92.90×41.65 @ -92.90,-10.00`，帧 1/2/25/50/75/99 全同），
  尽管实际几何在同一批帧里从 `x=-92.90` 滑到 `x=-4.05`。布局代码依赖这一点，跟错了整块界面位移。
  实现上因此新增 `Graphics._mdecl/_ml/_mt/_mw/_mh`，而**不复用** `_clip`（`_clip` 仍被渲染裁剪
  与普通 shape 的显示盒共用）；`as_bounds_walk` 的 `decl` 由 bool 变三态：`0` 几何（命中测试，
  morph 必须按实际绘制位置可点）、`1` 显示盒（`getBounds`/`width`/`height`）、`2` `getRect`。
- 类名是 `flash.display::MorphShape`。本后端给 `Shape`（最近的既有构造），像素一致、类名不同，
  由 `notes` 明说（§10 同一行）。
- 帧 1 的 `PlaceObject` 没有 `Ratio` ⇒ 按 **0** 处理。这条对**回退**尤其重要：`as_swc_bind` 既建
  帧 1 也是回退路径，它会复用同 `(depth, 字符)` 的对象；不重置就残留末帧几何（修复前
  `gotoAndStop(99)` 再回 `1`，`getRect.x` 停在 `-4.95` 而不是 `-92.90`）。

**⑥ 逐帧 `clipDepth` 遮罩（阶段三百一十九，v0.4.280）**

上面两条曾经是缺口，现由 §9.2 F12 收口：遮罩不再是烘焙期算好的静态轮廓，而是**每帧从活着的
遮罩兄弟对象重建** `as_clip_path(_clip_src)`，因此

- 帧尾把某个 depth 换成**另一个字符**（本库帧 100 把 morph 换成 `char73`）会**照常补上**
  新子件并重新武装遮罩区间，`numChildren` 两端都是 4（与 `adl` 一致）；
- morph 当遮罩可用（轮廓即它**当前** ratio 的绘制几何，见 F12 的偏差说明）；
- sprite 当遮罩取**子件并集**（洞保留），时间轴移动遮罩时裁剪区跟着走。

- **AIR 侧没有 AS3 出口能读到当前 ratio**（唯一出口是像素），而本库的 morph 全是遮罩，因此
  `examples/swc-morph.as` 只能钉显示盒契约；插值本身由 `test/unit/render.ts` 的
  `unit: render/SwcMorph` 逐条钉发射形态（含 `as_swc_lerp` 的实现体，因为「lerp 忽略 t」在
  文本上不可见）。像素对照靠 `temp/morph/MIso.as` + `ASC_MORPH_PAINT_MASK=1` 的诊断构建：
  帧 99 单画 morph `2816 px / ff0066ff`、回到帧 1 归 `0`，与几何插值的方向一致。
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
                  └─ tag 35 → **alpha 平面单独解压**，运行时合成（§3.2③）

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
mangled-header 补丁（那是给 LZMA-alone 13 字节头用的）。`examples/embed-assets/skin.swc` 是 `CWS`，此路径首期可不做，
但既然布局已定，实现成本很低。

---

## 5. 资源 → 产物：内嵌**编码字节**（本节结论已按实测改写）

用户已确定**编译期提取、编译期嵌入**（AIR 的资源类构造器是**同步**的，不能改成运行时异步加载）。
但嵌入的**内容形态**早期选错了：早期版本把 `DefineBitsLossless*` 解成**原始 ARGB** 再以 C 数组打进产物。
实测这是源码体积的最大浪费源（见 §5.1），应改为**嵌入编码字节**：

| 资源格式 | 嵌入内容（**编码字节**） | 运行时解码 |
|---------|----------------------|-----------|
| `DefineBitsJPEG2` (21) | **JPEG 原始字节直搬**（零转换） | 现有 `as_skia_image_decode_bytes_argb` |
| `DefineBitsJPEG3` (35) | JPEG 原字节直搬 **+ 解压后的 alpha 平面**（两个数组，§3.2③） | `as_swc_image_alpha` / `BitmapData_adoptEncodedAlpha`（先 Skia 解码再合成） |
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

**旧导出**（16 个命名资源）逐项实测：

| 形态 | 合计 | 说明 |
|---|---|---|
| SWC 内的压缩字节（tag payload） | **13,097 B** | fmt5 是 zlib 压缩的**预乘** ARGB |
| 解成原始 ARGB | **1,555,412 B** | 早期方案打算嵌入的东西 |
| **重编码为 PNG** | **14,569 B** | 只比 tag payload 大 11% |
| PNG 嵌入 C 源码（`\xNN` 转义字符串） | **43,723 B ≈ 42.7 KB** | **应采用的形态** |
| 原始 ARGB 嵌入 C 源码（`0xNN,`） | **7,777,060 B ≈ 7.42 MB** | **早期方案，错** |

单看旧导出最大的 `cambitmap`（700×393，tag 20）：原始 ARGB **1,100,400 B** → PNG **8,070 B**。
（tag 20 是旧导出独有：**当前夹具连一个 `DefineBitsLossless` 都没有**。）

**源码体积差 178×**（旧导出数字）——所以资源段只能是编码字节，不能是像素。

**当前入库夹具**的命名位图资源只有 **1 个**（`desktopicon` 342×194，§0.1），真正内嵌的集合就是一张 PNG：
`encoded` **1,671 B** ↔ 原始 ARGB **265,392 B**（**159×**）；而 14 个**未命名**位图（只被 shape 当填充引用）
一个都不内嵌——它们合计原始 ARGB **10,300,716 B**（仅 `#46` 2832×805 一张就 9.1 MB），这一对比正好说明
「资源必须编码后内嵌」不是省事，而是唯一可行形态。

资源段实际长这样（下面是当前夹具 `desktopicon` 的**真实发射结果**）：

```c
// SWC resource: <path>/skin.swc#desktopicon (342x194) — png bytes;
// decoded at runtime by as_skia_image_decode_bytes_argb (same path as Loader.loadBytes).
static const unsigned char __res_desktopicon[] =
  "\x89PNG\x0d\x0a\x1a\x0a\x00\x00\x00\x0dIHDR\x00\x00\x01V..."   /* PNG 总计 1,671 B */;

// 在资源类自己的构造器里（尺寸不必另存常量）：
BitmapData_adoptEncoded((BitmapData*)o, __res_desktopicon, (size_t)1671);
```

> 早期文档这里写的是 `__res_skin_logo_w/_h` 两个常量——**现在不再发射**：宽高由编码字节（PNG 的 IHDR）
> 自描述，少一份「常量与 IHDR 不一致」的隐患。

**与阶段七十八已不再冲突**：资源合计约 **42.7 KB C 源码**（相对 `hello.as` 的 854 KB 是 5%），
完全可以在**单个 `.c`** 内嵌，与「单文件 `.c` 是默认形态」一致。早期版本因选了原始像素形态，
才被迫写下「资源段**必须**独立 `.c`」——**那条强制项随本节结论一并取消**：

- **默认**：资源字节内嵌进同一个 `.c`（实测规模下无必要拆分）。
- **例外**：若某个 SWC 的资源总量使单一 `.c` 超过实现者设定的阈值（例如 >5 MB 源码），
  再降级为「资源段独立 `.c` + 构建清单 `sources` 合并」——构建层已支持（AGENTS.md §2.9）。
- 两种形态下 `-O2` 都会丢弃未被引用的资源段，不影响最终二进制体积。

  > **实测修正（2026-10-05，实施期）**：前半句**成立但须限定**。native `-O2` 下拿 `hello.as`（完全不引用任何资源）
  > 与加上 `--swc examples/embed-assets/skin.swc` 比：二进制 **130,552 → 195,880 B（+約 65 KB）**，其中 `__text` 59,012 → 99,556
  > （**+40.5 KB 代码**）、`__data` 4,088 → 17,384（**+13.3 KB 表格**）。**嵌入的 PNG 字节本身确实被丢掉**
  > （在产物里搜不到任何一张资源的完整字节），但**合成出来的 16 个资源类并不被裁**——它们的构造器/`_new`/虚表/
  > props 表/注册表项互相引用成一簇，链接器从可达根出发删不掉（且这是 **§6 要的语义**：`getDefinitionByName("logo")`
  > 必须随时能解析）。所以准确说法是：**未引用的资源“字节”会被丢弃，但资源“类”的开销会留在产物里**
  > （16 类约 53 KB / 即 ≈3.3 KB 每类；**这是旧导出的 16 类**，当前夹具只有 1 个资源类，量级相应降到 ≈3 KB）。
> 引用到某个资源时，其字节才真正进入产物。

> **编译期需要一个 PNG 编码器**：Node 内置 `zlib` 即可实现（IHDR/IDAT/IEND + 每行 filter 0，
> 约 100 行，零第三方依赖）。`DefineBitsJPEG2/3` 的 tag 本来就存着完整 JPEG，**原字节直搬、无需编码器**。
> **旧导出**的 16 个命名资源全为 lossless（无 JPEG 命中），故 PNG 编码器是首期必须品；
> **当前夹具**的 15 个位图里有 **2 个 `DefineBitsJPEG3`**（带独立 zlib alpha 平面）：JPEG 原字节可以直搬，
> 但必须走「运行时 Skia 解 JPEG + 合成 alpha 平面」（§3.2③ / §9.2 F7），PNG 路径覆盖不到它们。

### 5.2 不该内嵌的资源：桌面 / web / 移动三端的资源通道（**已存在，勿另造**）

「资源」不止 SWC 里那些编译期已知的位图类。大图、音频、字体、外部数据**不应**编进 `.c`——
它们需要懒加载，而且 web 首屏不该背一个巨大的 `.wasm`。好消息是这条通道**已经实现且已按平台分派**：

| 平台 | 现有机制 | 代码位置 |
|---|---|---|
| 桌面 native | `File.applicationDirectory` 解析到**可执行文件所在目录**（`as_app_dir()` 从自身路径推导：Windows `GetModuleFileNameA` / macOS `_NSGetExecutablePath` / Linux `/proc/self/exe`，WASI·Emscripten 退化为 `.`；与 `extensions/` 的 `as_ext_dir()` 同口径）→ 资源就是**普通文件**（`assets/...` 放在 exe 旁边），与 `adl` 的安装目录语义一致。**不依赖 CWD**，故产物可整体搬走（`-o bin-aot/App.exe` 时 app dir 就是 `bin-aot/`） | `emit.ts`（`as_app_dir`）、`air-app.ts` |
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

这是决定 codegen 怎么落地资源引用的关键。**旧导出**的 `library.swf` ABC 里：

```
public dynamic class logo extends flash.display::BitmapData
  public function logo(int,int):*
public dynamic class imgback extends flash.display::BitmapData
public dynamic class desktopicon extends flash.display::BitmapData
public dynamic class cambitmap extends flash.display::BitmapData
```

**当前入库夹具**的 ABC 里只剩 `desktopicon` 一个资源类（在 ABC 字符串表里扫 `BitmapData` 只命中一次），
其余 34 个导出全是**显示对象**符号：

```
public dynamic class desktopicon extends flash.display::BitmapData
  public function desktopicon(int,int):*     // 构造器签名与旧导出一致
upvpage     -> flash.display.SimpleButton
applistskin -> flash.display.MovieClip
```

**资源类（任何 `flash.display.BitmapData` 的动态子类）的构造器签名是 `(int width, int height)`**。
这是 Flash IDE 导出皮肤库的标准形态。

> **构造器参数会被忽略**——实测（旧导出）`new logo(0, 0)` 得到的 `BitmapData` 是 **100×72**、（当前夹具）
> `new desktopicon(0, 0)` 得 **342×194**（真实尺寸来自 SWF tag），都不是 `0×0`。工厂里**必须用资源自身的
> 宽高**，不能采信实参（写成 `new desktopicon(0,0)` 是 Flash IDE 生态的惯用写法，参数位形同占位）。

**旧导出**的 `SymbolClass` 有 214 条映射，其中只有 16 个**位图**直接映射到类名、其余 43 个位图没有类名
（被 `Sprite`/`DefineShape` 作为子对象引用）：

```
desktopicon  logo  imgback  cambitmap
com.vsdevelop.controls.scrollbar.ScrollSkin_{top,middle,bottom,...}SkinClass[_200]   （12 个全限定名）
```

**当前入库夹具**只有 **35 条映射**（§0.1），且**只有 1 个位图**（`desktopicon`）有类名——其余 34 条映射到
的全是**显示对象符号**（`DefineSprite`/`DefineButton2`/`DefineEditText`），落在「需要解析显示树」那一档：
`desktopshareitem` `homeskin` `checkbom` `toastbtn` `upvpage`(button) `元件97` …；另 14 个位图无名，只作
shape 填充。

> **早期版本此处有两处错误**（当时针对旧导出，当前夹具同理可验）：
> ① 举例里的 **`checkbom` 不属于位图那一档**——实测它是 **`DefineSprite`（tag 39）**（旧导出里
> symbol 154，当前夹具是 #26），落在「需要解析显示树」那一档（下一节）。
> ② 旧导出 16 个命名资源里有 **12 个是全限定名**（`com.vsdevelop.controls.scrollbar.*`），这对
> 「方式一：直接 `new 资源类`」是硬约束——现实代码几乎不会写 `new com.vsdevelop....(...)`。
> **当前夹具把这 12 个全限定名资源整个去掉了**（没有 scrollbar 组件），唯一资源类 `desktopicon`
> 就是顶层短名——但方式二仍是首选落地（理由见下）。

**AS3 侧引用方式（两种，按用户代码风格分）**：

| 引用方式 | 典型代码 | codegen 落地 | 适用范围 |
|---------|---------|-------------|---------|
| 直接 `new 资源类(w,h)` | `var b:Bitmap = new Bitmap(new desktopicon(0,0));` | 资源类注册为 `BitmapData` 子类，`new` 分发到「嵌入像素填充」工厂（忽略实参、用 tag 宽高） | 顶层短名资源（旧导出实测 4/16；当前夹具 1/1） |
| `SymbolClass` 反射 | `getDefinitionByName("desktopicon")` | 资源注册表 `{name → 工厂指针}`，动态查表 | 全部命名资源类（旧导出 16 个、含 12 个全限定名；当前夹具 1 个） |

> 反射路径**不再是「后续扩展」**：`emit.ts` 已有 `flash.utils.getDefinitionByName` 注册表
> （`getQualifiedClassName` ↔ `getDefinitionByName` 往返），把资源类登记进去即可复用。
> 旧导出有 12/16 是全限定名（当前夹具根本没有全限定名资源类，但那是夹具差异、不是机制差异），
> **仍建议把方式二作为首选落地**，方式一作为便利补充。

---

## 7. 实现落点（对齐 AGENTS.md 分层）

| 层 | 改动 | 说明 |
|----|------|------|
| **构建层 `src/swc.ts`（新增）** | SWC 提取器 | ZIP 解析 + CWS/ZWS 解压 + stage header 跳过 + tag 扫描 + 位图提取 + **反预乘（§3.2）**，产出 `SwcResource[]`（类名/格式/宽高/straight ARGB 像素或 JPEG 字节）。**资源全量解析**；`DoABC` 只解**符号类的帧脚本**（§3.3 收口），一般类方法不碰；同时读 `catalog.xml` 的 `<script>/<dep>` 供 §3.3.3 的早期诊断用 |
| **构建编排 `src/build.ts`** | `--swc` 参数 / 构建清单 `swc-paths` | 收集 SWC 依赖，调用提取器；资源段超过阈值时生成独立资源 `.c` 并接入 `sources`（§5.1，**默认不拆**） |
| **语义层 `src/symbols.ts`** | 资源类注册 | 把资源类名注册为 `BitmapData` 子类（`dynamic`，构造器 `(int,int)` 但**实参忽略**） |
| **语义层 `src/emit.ts`** | 资源段发射 + `new`/反射分发 | 发射 C 编码字节资源段（PNG/JPEG，§5.1）；`new logo(w,h)` 分发到「内嵌字节 → Skia 解码 → BitmapData」工厂，宽高取**资源自身**值；资源类同时登记进既有 `getDefinitionByName` 注册表（§6） |
| **运行时 `src/runtime.ts`** | **无需新增** | 所需能力已存在：`as_skia_image_decode_bytes_argb(data, len, &w, &h)`（`emit.ts` 已在 `Loader.loadBytes` 使用），内部走 `DeferredFromEncodedData` + `readPixels(kUnpremul)` → 直接产出 straight ARGB。早期版本列的 `as_skia_image_from_bytes` 是多余的 |
| **构建层 `src/swc.ts`（扩展）** | `DefineShape*` → C 路径构建代码 | 复用现有 ZIP/CWS/tag 扫描链路；shape 解析按 §3.4④，产出「子路径 + 样式索引表」中间表示，再发射 `sk_path_*` 调用。**编译期完成，运行时零 SWF 解析** |
| **语义层 `src/emit.ts` + 运行时 `src/runtime.ts`** | `Graphics` 模型升级 + glue 补齐 | 见 §5.3：子路径/样式索引模型、径向渐变、位图填充 shader、描边 cap/join/miter、`sk_path_close` 语义 |

**边界铁律**：提取逻辑（ZIP/SWF 解析）**只能**发生在编译期（`swc.ts`），**禁止**塞进 `RUNTIME_PREAMBLE`
——那会让运行时背一个 SWF 解析器，违反「前端只翻译」铁律（AGENTS.md §1.3）。反预乘同理放在编译期。

**第二条边界**：`swc.ts` **资源全量解析**；`DoABC` **只解「符号类的帧脚本」**（§3.3 收口）——
那足够让勾选框/按钮皮肤真的切帧，而**一般的类方法不执行**（一个类 1400+ 个方法体、54 KB 字节码，
全跑起来就是 AVM2，属另行立项）。`catalog.xml` 的 `<dep>` 只用于**名字层面**的早期诊断（§3.3.3）。

**第三条边界（阶段一百九十六 起）**：符号类的**基类**取自它自己的 `DoABC`（AVM2 的 `InstanceInfo.super`
multiname），但**只有本次编译真的提供那个类时才绑定**（`swc.ts::availableProjectBase`，判定由调用方
`index.ts` 用它正在编译的源文件集合回答）。理由与做法：

- `skin.swc` 的四个组合框都继承 **App 自己**的 `com.vsdevelop.controls.ComBoBox`（同名类的**源码**在
  `src/` 下）。AIR 在同一份输入上把库里的符号链到**库外**那个类上，行为来自源码；我们照做（阶段一百九十一）。
- 库里那份**同名副本**是 ABC 代码，不参与编译（本节第一/二条边界），所以当编译单元里**没有**这个类时，
  生成的 `class ComBox extends <不存在的类>` 会直接编译失败（`unknown superclass`）。
- 此时**回落**成纯美术符号（`MovieClip`/`SimpleButton` 子类），并**响亮告警一次**（按基类名去重）：
  `warning: SWC symbol class extends '<基类>', which this compilation does not provide: …`。
  回落**不是静默降级**——告警写明缺哪个基类、退化成什么、少了哪些成员；而 `adl` 对同一份输入照跑不误
  （它执行库里的那份基类），故「库内基类的行为」仍是 `TODO.md` 的遗留项。
- 动态特性（`dynamic`）与基类**无关**，任何时候都按 ABC 原样复现（阶段一百九十二）。

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

**方法**：`temp/swc-render/`（harness 由 `gen.ts` 从 `examples/embed-assets/skin.swc` 生成一份共享 body，两侧分别用
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

**验收基线（旧导出，可直接复用该次复核的数据）**：对当时的 `skin.swc` 跑提取器，
① 16 个命名资源全部提取；② `logo` 为 100×72 且为**反预乘后**的值（先解出 straight ARGB，再编码成 PNG）；
③ **与 `adl` 的 `getPixel32` 逐点比对**（§11 的方法），允许 ±1 通道偏差；
④ 体积：16 个资源的编码字节合计 ≈ **14.6 KB**（PNG），C 源码 ≈ **43 KB**（而非 7.42 MB）；
⑤ 矢量：**378/378** shape 解析 round-trip 全中，且导出符号闭包（322 shapes / 327 sprites）的渲染结果
与 `adl` 截图对照（§3.4、§11⑤）；
⑥ 九宫格缩放（22 个 `DefineScalingGrid`）与按钮四态（29 个 `DefineButton2`）与 `adl` 截图对照；

**验收基线（当前入库夹具，`examples/embed-assets/skin.swc`）**——同一套判据，换成现测值：
① **15 个位图 tag 全部解出**（`DefineBitsLossless2`×13 + `DefineBitsJPEG3`×2，后者带独立 alpha 平面），
   其中只有 **1 个是命名资源类 `desktopicon`**，其余 14 个无名、仅作 shape 填充（§0.1）；
② `desktopicon` 为 **342×194** 且为**反预乘后**的值（`examples/swc-bitmap.as` 把它钉到了具体像素：
   `(0,0)` 全透明、`(1,97)=0xffcccccc`、`(171,97)=0xfff6f6f6`、`(341,193)` alpha `0xcf`）；
③ 同一份字节与 `adl` 的 `getPixel32` 逐点比（§11 的方法），允许 ±1 通道偏差；
④ 体积：命名资源的 `encoded` **1,671 B**（PNG）→ C 源码里的 `\xNN` 串 ≈ **6.7 KB**；
   全部 15 个位图的原始 ARGB 合计 **10,300,716 B**，一个都不内嵌；
⑤ 矢量：**90 个 shape 字符**（`DefineShape`×54 + `DefineShape2`×10 + `DefineShape3`×4 + `DefineShape4`×22）
   全部解析并烘焙；带描边无填充的字符（如 #36）必须只发 `as_swc_stroke`、不发 `as_swc_fill`；
⑥ 九宫格（**5** 个 `DefineScalingGrid`）与按钮四态（**4** 个 `DefineButton2`，其中 `upvpage` 导出为
   `SimpleButton`）与 `adl` 对照；
⑦ 时间轴：**21 个多帧烘焙剪辑**（`FrameLabel`×36，其 11 个带 `_up/_over/_down`）的帧脚本、回退复用与
   `currentLabels` 与 `adl` 一致（§9.2 F6/F8/F9）。

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
否则 up→over→down→hit 回退。指针坐标（`_mouse_x/_mouse_y/_mouse_has`）存在**该按钮所属的那个 Stage**
上，由 `Stage_dispatchMouse` 写入（`ASC_mouse_down` 仍是进程级的按键态：一个 OS 指针、一个按键），
因此**窗口的 SDL 回调与 AS3 的 `stage.dispatchMouse(x,y,type)` 测试钩子都会驱动四态**；而**每个
Stage 各有一份指针**（AIR 一个 NativeWindow 一个 Stage），别的窗口动鼠标不会推开本窗口的悬停态。
指针从未到过的 stage（离屏 `BitmapData.draw`、没有窗口的构建）保持 up 态 —— 这也是 §9.1 的离屏
验收只比 up 态的原因。

**悬停门与坐标门是两回事（实测）**：`_mouse_in`＝「指针现在在本窗口内」，`_mouse_has`＝「已知一个
指针位置」。悬停态（SimpleButton 四态、MovieClip 按钮态、拾取目标刷新）门在 `_mouse_in` 上；
`mouseX/mouseY` 门在 `_mouse_has` 上。理由：adl 51.4.1 实测（双窗口 + 真实指针）指针**离开窗口**时
悬停态回滚到 up，但 `mouseX/mouseY` **保留**最后那个窗内位置（179.9,203.6，既不清零也不跟随另一个
窗口），并按序派发 mouseOut → rollOut（具体对象）→ `"mouseLeave"`（Stage 上）。本运行时按此实现：
后端把 `SDL_WINDOWEVENT_LEAVE` 以保留类型 `"mouseLeave"` 送进鼠标通道（指针坐标带 0,0，AS3 侧忽略），
`Stage_dispatchMouse` 收到后只清 `_mouse_in`、派发 Stage 上的 `mouseLeave`，**绝不碰坐标**；按键
未松时不当作离开（AIR 把按压闩在按下的那个对象上）。另外，**报上来的 LEAVE 不等于真的离开**：
窗口在静止指针下被抬起/激活时 Windows 会发 `WM_MOUSELEAVE`，SDL 随之报一个指针仍在窗内的 LEAVE
（实测），所以后端会按几何再判一次「指针是否真的在窗外」再转发，避免应用收到假的 `mouseLeave`。
（具体对象的 mouseOut/rollOut 仍需「本舞台当前悬停对象」，是尚未实现的那部分。）

**命中判定（本项真正的坑）**：窗口探针里 hover 恒为 0。根因：`as_sbtn_contains` 最初用
`as_pick_hit`，而它**只报告 InteractiveObject**；按钮的 hit 态是用**普通 `Shape`** 搭出来的，于是永不命中。
改为几何判定——把舞台点映到按钮本地空间，再映射进 hit 态自身空间，调用
`as_obj_region_hit_local`（走它自己的子件与轮廓），即 AIR 真正命中的那块区域。修复落在**共用助手**层：
拆出 `as_sbtn_contains_local`（本地空间）供 `as_sbtn_contains`（舞台空间）与
`as_sbtn_state` 的历史路径共用——结构回归见 `examples/swc-shape.as`。

> **阶段一百五十七 校正（本节旧文曾写「`hitTestPoint(x, y, true)` 也跟着按 hit 态几何判定」）**：
> `as_obj_region_hit_local` 对 `SimpleButton` **刻意直接回 false**（按钮的四个态是彼此独立的子对象，
> 自身没有形状区域；`temp/sbtnstate2/` 七个探针：即便 `hitTestState` 是实心 60×60 且在台上，
> `hitTestPoint(x, y, true)` 仍为 false），而 `as_sbtn_contains_local` 是 **hover 与鼠标拾取共用**的
> **输入命中区域**。二者分工由此固定：绘制/包围盒/形状区域三问不变，**只有当「这只鼠标点谁」时才问 hit 态**
> —— 真应用 talkmed-meeting 里那 29 个「只有 down + hit」的隐形按钮（个人中心三行、`选择企业` 返回箭头）
> 正是因为拾取还去问绘制态的包围盒而**完全点不动**，修法见 `src/emit.ts` 的 `as_pick_hit_local`。

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
普查 `examples/embed-assets/skin.swc`（`temp/swc_po3_visible.ts`）：**64 条 `PlaceObject3`，其中 63 条落在导出符号的
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
node temp/swc_po3_visible.ts ../examples/embed-assets/skin.swc
# 对象树对照（ours 与 adl 各一份，逐子件 visible）
cd temp/vishidden && node gen.ts && ../../src/index.ts ours.as --manifest t.build.json --run && ./run_adl.sh && diff adl.txt ours.txt
# 1× 全量像素重测（§9.1 的同一套 harness）
cd temp/swc-render && <ours> && ./run_adl.sh && node compare.ts

# 结构回归（矢量/显示树/九宫格/按钮四态，两侧构建都成立）
cd as3compiler && node src/index.ts examples/swc-shape.as --swc ../examples/embed-assets/skin.swc --run
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

**属主分布**（`node temp/swc_po3_detail.ts ../examples/embed-assets/skin.swc`，只统计在烘焙闭包内的条数）：

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
node temp/swc_po3_detail.ts ../examples/embed-assets/skin.swc
# 强度模型 / box 模糊模型 / 不变量（两侧各跑一次，CHK 逐行相同）
cd temp/filterprobe && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh
# 属性指纹（滤镜子件、blendMode、cacheAsBitmap 逐项对 adl）
cd temp/attrsprobe && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && diff adl.txt ours.txt
# DropShadow 双重缩放事故的逐像素质证（entry 29 popcontrolskin 425x124）
cd temp/swc-render && RAW=29 node gen.ts && <ours> && ./run_adl.sh && node rawpng.ts raw_ours.bin raw_adl.bin . && node pixq.ts 29
# 1× 全量像素重测
cd temp/swc-render && <ours> && ./run_adl.sh && node compare.ts
# 结构回归（glow / darken / layer / cacheAsBitmap 的树与字段断言，纯结构、不依赖 Skia）
cd as3compiler && node src/index.ts examples/swc-shape.as --swc ../examples/embed-assets/skin.swc --run
```

---

### 9.2 F5 未支持字符的占位子件 + 子件变换/包围盒对齐（阶段九十五·八，v0.4.66）

**背景**：`temp/childfx/` 探针（15 个导出符号 / 99 个子件）逐子件对 `adl` 打印 `numChildren`、
`getQualifiedClassName`、`x/y`、`width/height`、`transform.matrix`、`visible`。修前：`x/y` **全错**
（我们一律 `0,0`）、`numChildren` 偏少（`minfo` 我们 2 vs `adl` 6）、`width/height` **39 处**不符。
修后：**`x/y` 0 处不符、`numChildren` 0 处不符、`width/height` 35 处**（其中 3 处源自 morph 几何缺失，
其余 ≤0.021px 的精度级差）。

**① 文本字符烘焙成真 `TextField`（`DefineEditText` 全量解码）**

- `DefineEditText`(37) / `DefineText`(11)：实测本库 **341 个**（338 + 3）。
  **阶段一百四十九**起 tag 37 的整张字段被**逐字段解码**并盖到实例上：InitialText（`hasText`）、
  `HasFont` 的 `FontID`→`FontName` + `FontHeight`、`HasTextColor` 的 **RGBA**、
  `HasLayout` 的 align/margins/indent/leading、以及 Multiline/WordWrap/Password/ReadOnly/
  NoSelect/Border/HTML/MaxLength 各标志。于是「皮肤里的每一行字」都真的画出来了——修前
talkmed 的协议段落、页脚、按钮文案**整体缺失**（字段是空的）。
- **flags 是 MSB-first 的 16 位字**（一个位字段序列），**不能**按 LE `UI16` 读：本库 #92 的两字节
  `ad 36` 作 MSB-first 读为 `0xad36` = HasText|Multiline|ReadOnly|HasTextColor|HasFont|HasLayout|
  WasStatic|HTML，与该字符完全吻合（它自己的文本就是 `<p align="left"><font face="MiSans Regular"…`，
  FontID=5，而库里 font 5 正是 `MiSans Regular`）；按 LE 读成 `0x36ad` 则**每一位都变成另一位**。
  旧实现的 `autoSize = (第二字节 & 0x80)` 因此读的是 **HasFontClass**（本库 341 个全 0，所以看起来
  「永远为 0」），并非 AutoSize。现在 `SwcText.autoSize` = flags 的 `0x0040`，本库 **341 个全为 0**，
  故占位框按 `RECT` 报即与 AIR 无差。
- `FontID` → `FontName` 由 tag 48/75/91（`DefineFont2/3/4`）只读 `FontName` 得到；`FontNameLen`
  实测**含结尾 NUL**，故解析后要截掉。本库 7 个字体族：`MiSans Regular`/`微软雅黑`/`宋体`/`Arial`/
  `04b_08`/`微软雅黑 Light`/`Matura MT Script Capitals`。**嵌入字体的字形轮廓仍未解码**（不由 SWC
  造字体文件），故这些族名走 Skia 的系统字体别名，度量有残差——已声明缺口。
- `DefineText`(11) **仍烘焙成空框**：它的字形 run 要对嵌入字体的 `CodeTable`（字形索引→字符码）
  才能还原，本库只有 3 个，用 `notes` 报明。
- `notes` 现在按类分别报告：`N text character(s) are baked as TextFields: X DefineEditText … carry
  their decoded InitialText + TextFormat (Y have a non-empty string), Z DefineText … still bake as an
  EMPTY box …`。
- `DefineMorphShape`(46) / `2`(84)：实测闭包内 **6 个** ⇒ 烘焙成**空 `Shape`**（AIR 是 `MorphShape`，
  `Shape` 的子类；本工程无此类，故 `getQualifiedClassName` 报 `Shape`）。树形（个数/索引）对齐、
  **不画错像素**（空 Shape 不画），几何缺失用 `notes` 报明。
- 旧实现是「`unsupported` ⇒ 摆放处直接跳过」，会**连子件都没有**；现在是「建真子件 + 报明」。
  `is TextField` 对文本子件成立（`examples/swc-shape.as` ⑦ 断言）。

**② `clipDepth` 遮罩对象是子件，不是「不存在的子件」**

实测 `skin_fla.元件27_310` 的 `c0` 在 AIR 里是 `MorphShape`、`visible=true`、有自己的包围盒（1×18），
只是**从不被绘制**。修前我们把遮罩字符标 `unsupported` —— 那会让该字符**在任何位置**都不再出现（潜在 bug）。
现在改为：遮罩摆放**保留为子件**，另置私有字段 `_mask_object`（C 运行时专用；DisplayObject 构造时 `false`），
`as_render_object` / `as_pick_hit_m` 见到就整体跳过。morph/sprite 遮罩无法表达为路径裁剪 ⇒ 一句 `notes`
报明（`clipDepth mask …`），不再 `unsupported`。实测 `fileitemskin.c2`：AIR `n=4`（含 `MorphShape` 遮罩）
↔ 我们 `n=4` ✓。

**③ placement 平移落到子件自身 `x/y`（scale 仍留在 `transform.matrix`）**

`emitSwcPlacement` 现在只把 2×2（旋转/缩放/斜切）写进 `transform.matrix`，**平移**写进子件自己的 `x/y`。
实测 AIR：非文本子件 `child.x == matrix.tx`（`vbitemskin c4 xy=41,23.75`）。**文本子件另加其 `RECT` 原点，
且原点要走 placement 的线性部分、再落到 AIR 的 twip 栅格（1/20 px）**：`x = round20(tx + a·xmin + c·ymin)`
（stage 170 修正；此前是 `tx + xmin`，只在**单位缩放**的子件上与 AIR 相同 —— `temp/childfx` 那 99 个子件全是
单位缩放故未暴露，一旦 placement 带缩放即偏，如 `subtitleskin.ctime` 偏 11.7px）。判别证据 = `temp/tfswc`
case ⑰ 的四个子件（`ctime 12.0000`/`filesskin.tab1 0.0500`/`tab2 90.1000`/`logintabskin.tab1 0.0000`，
`adl` 报的每个数都是 1/20 的整数倍），实现见 `src/emit.ts` 的 `swcTextChildXY`。缩放**必须**留在矩阵里：
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

**⑥ 遮罩路径必须**闭合**每个子路径（否则整块区域被裁掉）**

`clipDepth` 遮罩的轮廓直接当作裁剪路径（`as_swc_clip_path_new`）。真应用 `skin.swc` 的遮罩 `#346`
是 `moveTo/lineTo×4`、**没有 `close`** 的 5 个 verb —— `kWinding` 下这条路径**什么都不填充**，
于是被遮的登录页轮播 `banner`（以及 `con`/`titletext`/`confbtn2`）**整块被裁成空**（用户看到
「轮播只有第一张图／空白」）。实测（`temp/tkmeet-mac/`，临时胶水探针 `sk_path_dbg`）：
`SRC346 fillType=1 verbs=5 pts=5 bounds=0,0,36.25,18.5 empty=0` / `DST346 fillType=0 verbs=5
pts=5 bounds=0,0,354,402.5`；对照实验：手搭矩形（closed）✓ 渲染、烘出的路径 + `as_skia_path_close()` ✓
渲染、手搭 **closed 三角形** ✓ 渲染 ⇒ **闭合轮廓（任意形状）都能裁；未闭合轮廓把整块区域裁空**。

**修法**：胶水层新增 `sk_path_close_all(void* path)`（用 `SkPath::Iter` 把**每一条**子路径都改写为
已闭合；不能用 `SkPath::close()`，它只闭合**最后一条**，多轮廓遮罩仍会坏），发射侧在
`as_skia_path_add_transformed(...)` 之后立刻调一次。**修在「裁剪路径构造器」而不是形状发射器**：
裁剪是「填充区域」，闭合它**语义不变**；而形状发射器里的描边轮廓**允许开放**，在那里补 `close`
会改掉描边渲染。钉在 `test/unit/render.ts` swctimeline。

**⑦ 遮罩活在**父**空间：裁剪必须设在对象自身变换**之前**（否则遮罩跟着对象跑）**

`clipDepth` 遮罩是**兄弟节点**（同 parent、depth 在 `(maskDepth, clipDepth]` 区间内），它**不随**被遮对象运动。
烘焙曾把遮罩矩阵合成到**子件局部像素**（`inverse(childMatrix) * maskMatrix`），渲染时又在 `translate(o->x, o->y)`
**之后**裁剪 ⇒ 遮罩**跟着对象走**。对登录页轮播（`banner` 被 `TweenLite.to(..., {x:-(index-1)*354})` 横移、
遮罩固定）后果正是用户看到的「**只显示第一张图**」：只有 `x==0`（局部≡父空间）时遮罩与视口重合、露出第 1 张，
之后遮罩随胶片移出卡片 ⇒ **整块空白**。实测（`temp/tkmeet-mac/shots/`）：修前 `spc_early`（x≈0）有图、
`spc_late`（x≈-725.7，由 `[diag] banner visit=150 x=-725.7` 记录）**全空**；修后 `fix_early` 与 `fix_late`
**各有内容且是不同两张**（`ImageChops` 差值 `changed_px=33476`）。

**修法**：烘焙只传遮罩**自己的** placement（父空间），渲染走查把 `clip_path` 从「变换之后」搬到
对象 `save` **之后、`translate` 之前**（同时也落在 `alpha` 的 `saveLayer` 之前，让层本身被裁）。
钉：`test/unit/render.ts` swctimeline 的『the clipDepth clip is applied BEFORE the object transform』。

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
node src/index.ts examples/swc-shape.as --swc ../examples/embed-assets/skin.swc --run
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
| `totalFrames` | = SWF 的 `ShowFrame` 条数（旧导出：`desktopshareitem` 21、`devicesitemskin` 23、`元件16_124` 17、`checkbom`/`toastbtn` 2、`元件172_339` 3；**当前夹具**：`元件77_50` 100、`元件16复制12_68` 23… 见 §0.1 与 `skin_fla.元件16_54` 17 / `元件17_55` 11 / `checkbom`/`toastbtn`/`元件20_57` 2） |
| 新建剪辑的初态 | `currentFrame == 1`、**`isPlaying == false`**，且在显示列表上**跨 12 帧也不自走**（离屏与上屏都一样）⇒ 皮肤符号的 `stop()` 在 DoABC 里；**帧脚本从 v0.4.127 起由编译期解码并真的执行**（§3.3 收口），所以这不再是"读不到而不得不停在第 1 帧"——而是**文件里就写着 `stop()`**，执行它才是对齐 AIR |
| 属性名 | 是 **`isPlaying`**（没有 `playing`） |
| `currentLabel` / `currentFrameLabel` | 该帧的 `FrameLabel` 名，或 `null` |
| `currentLabels` | **`Array` of `FrameLabel`**（`{name, frame}`），与我们的解析逐条一致（如 `_up@1 _over@8 _down@15`） |
| `gotoAndStop(n\|label)` | **前进**：就地打增量（子件身份保持）；**后退或回到 1**：**复用**目标帧上「同一（父, 深度, 角色）」的现有子件（对象身份与运行期状态都保留），只有该位置的角色**变了**才换新对象——详见下方「回到旧帧的复用规则」 |
| `nextFrame` / `prevFrame` | 步进 + **回绕**（`totalFrames` 处回 1、1 处回 `totalFrames`） |

**实现**

- **解析**（`src/swc.ts`）：新增 `FrameLabel`(43)（`readSwfCString` → `SwcSprite.labels`）；**新增
  `RemoveObject`(5)/`RemoveObject2`(28)** → `charId: null, move: false` 的删除记录；`SwcPlacement` 增加
  `visibleFlag: boolean|null` 三态（`Visible=1` 必须**取消**隐藏，缺该字段则**不动**可见性）与 `ratio`。
- **烘焙**（`spriteFrames`，键 = Flash **深度**而非子件索引）：帧 1 建立 `depth → {charId, matrix}` 状态，
  逐帧推演：带字符 = 新增/替换（`replace: true`，继承记录省略的变换）、`Move` 且无字符 = 修改、无 `Move`
  且无字符 = **删除**、同帧同深度后写覆盖先写；**什么也没带的 op 直接丢掉**并计数报明（本库 270 条
  只带 morph `Ratio` 的记录）。`SwcBakeCharacter` 增加 `totalFrames`/`frames`/`labels`。
- **发射**（`src/emit.ts`）：`as_swc_tl_total/start/find/put/del/apply/rewind/reuse/new/link/unlink` + `as_swc_tl_labelcount/
  labelat/frameat/label/labelframe`（静态 `switch (charId)`，标签名用 `strcmp`）；`MovieClip` 增加
  `play`/`stop`/`gotoAndPlay`/`gotoAndStop`/`nextFrame`/`prevFrame` 与 `isPlaying`/`currentLabel`/
  `currentFrameLabel`/`currentLabels`；新内建类 **`FrameLabel`**；时间轴子件带深度 `_tl_depth`
  （0 = 用户 `addChild` 的子件）以便「回到旧帧」只认领/清理时间轴子件（v0.4.143 起回退改为
  **复用**，见下方「回到旧帧的复用规则」）。**无 bake 时全部发空桩**。
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

**回到旧帧的复用规则（阶段一百七十二，D43）**

上面的「后退 → 重建目标帧的对象」是 v0.4.68 的粗口径，**收回**：adl 51.4.1 的实测规则是
「**目标帧在同一（父, 深度）上还是同一个角色 ⇒ 复用原对象**（连 App 运行时写进它的属性、
`TextField.text`、事件监听一起保留）；角色不同 ⇒ 才换新对象」。证据 `temp/btnprobe/`：

- `Rewind.as`：往 `homeskin.joinmeeting` 卡片的 `label1/label2` 写 `MARK0/MARK1` 后
  `_up(1) → _over(5) → _down(11) → _up(1)`，四个标签/文字全程保留（AIR 每帧写出 `label1.text`）。
- `Rewind2.as`：逐层打印子对象**编号与身份**（`#n`）+ 自动实例名，实测

  ```
  card f=1 children: 0:#0/sh/instance8@0,0  1:#1/tf/label1@16,16  2:#2/tf/label2@16,44  3:#3/sh/instance9@0,0
  over f=5 children: 0:#0/sh/instance8@0,0  ...(1/2/3 未变)
  back to up f=1 children: 0:#4(new)/sh/instance28@0,0  1:#1/tf/label1  2:#2/tf/label2  3:#3/sh/instance9
  ```

  即：深度 1 的角色在帧 1（518）与帧 5（524）不同 ⇒ 退回时换新对象（`instance8 → instance28`）；
  深度 2/3 的角色没变 ⇒ **对象编号原封不动**。
- 实现（`src/emit.ts`）：回退路径由 `as_swc_tl_clear + as_swc_bind` 改为 `as_swc_tl_rewind`——先把当前
  子件按 `(parent, 子件)` 存进快照数组（`ASC_tl_snap_par/obj`，`gc_root_register` 过的静态槽，嵌套
  回退各存一层），重跑帧 1 时 `as_swc_tl_reuse(parent, depth, charId)` 先认领快照里同（深度, 角色）的
  对象，再按 `as_swc_tl_apply` 打到目标帧，最后按**对象指针**（不是深度）清掉没人认领的残留。
  每个烘培子件都知道自己来自哪个角色（`_tl_char` 从 `MovieClip` 移到 `DisplayObject`，由 `as_swc_new`
  统一盖章）。
- 症状与现场：TalkMED 首页卡片标题是 App 运行时写进皮肤 `TextField` 的，旧实现下悬停一次再移开
  就被皮肤原稿覆盖（「快速入会」→「加入会议」）；修后 `temp/tkmeet-mac/s172labels.py` 量到
  移出前后**整窗（排除 FPS 浮层）0 像素差**、两条标签带各自 0 差。

**残留（D43b）**：**前进**方向上「`Move` + 新字符」的记录，AIR 保留原对象身份，我们仍换新对象——
因为烘培类是把图**画进类里**的（一个角色一个类），换角色就必然换实例。D43b 不影响文字保留
（只有角色真的变了才会触发），记在差异文档里待后续架构层处理。

**烘焙口径的数量（`temp/tlcheck.ts`）：** 旧导出：79 个多帧 sprite、其中 **75 个**帧 1 之后有变化、
**448** 个 op 帧、**514** 个 op（**102** 增/替、**404** 改、**8** 删）、**89** 条 `FrameLabel`（31 个 sprite）。
**当前夹具**现测：多帧烘焙剪辑 **21** 个、`FrameLabel` **36** 条（11 个剪辑带 `_up/_over/_down`）、
`RemoveObject2` **4** 条、`PlaceObject2` **403** + `PlaceObject3` **18**（§0.1）。

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
② **每帧 ActionScript（DoABC）只有符号帧脚本执行**（v0.4.127 起，§3.3 收口），一般类方法仍不执行；③ morph 时间轴的 `Ratio` 记录被丢弃（morph 是
空占位子件）；④ 子件 `x/y` 的**末位差**（`0.9500000000000002` vs `0.95`，≤2 ULP，来自两次 `/20` 相加）。

**复现**：

```
# 时间轴 API 逐项对 adl（68 行）
cd temp/tlprobe && node gen.ts && ../../src/index.ts ours.as --swc ../../examples/embed-assets/skin.swc --run && ./run_adl.sh && python3 cmp.py adl.txt ours.txt
# 烘焙口径与 op 计数
node temp/tlcheck.ts
# 子件树（15 符号 / 99 子件）
cd temp/childfx && node gen.ts && ../../src/index.ts ours.as --manifest ../swc-render/t.build.json --run && ./run_adl.sh && python3 cmp.py
# 1× 全量像素（须与 rep_final.txt 逐行相同）
cd temp/swc-render && node gen.ts && <ours> && ./run_adl.sh && VERBOSE=1 node compare.ts
```

---

### 9.2 F7 `DefineBitsJPEG3` 的 alpha 平面（阶段一百五十九，v0.4.130，diff doc D25）

**现象**：TalkMED 首页两张卡片（“快速入会”/“创建会议”）的插画位置是**黑矩形**，`adl` 同页是透明的。
`temp/alphaprobe/probe.mjs` 扫出全库只有两个 tag 35（`#1113` 186×160、`#1118` 167×162），
即这两张图。

**根因**：早期提取器只搬 JPEG 字节、扔掉 alpha 平面，并打一句「not composited」的 warning。
FLA 导出时透明区被填**黑**，于是透明区画成黑矩形。这不是 PNG 编码问题，而是**漏了一个 SWF tag 形态**。

**实现**（两处，共约 90 行）：

- **编译期**（`src/swc.ts`）：`DefineBitsJPEG3` 分支用 `node:zlib` `inflateSync` 解压平面，
  校验解出长度 ≥ `宽×高`（取前 `宽×高` 字节，容忍尾部填充）；空平面 / 坏流 / 长度不足一律
  **响亮告警 + `alpha = null`**（退回原行为，不拿垃圾覆盖度合成）。
- **运行时**（`src/emit.ts`）：平面另发一个 `static const unsigned char` 数组（`__swcbmp_<id>_a` /
  `__res_<name>_a`），新增 `as_argb_apply_alpha`；两条路各接上——**位图子件/资源类**走
  `BitmapData_adoptEncodedAlpha`（Skia 解完 JPEG 后叠平面，重新建 `bd->image`），
  **位图填充**走 `as_swc_image_alpha`（填充 shader 采样的是 SkImage，不是 `pixels`）。
  无平面时两条路**一字不变**（仍走 `BitmapData_adoptEncoded` / `as_skia_image_from_bytes`，保住惰性解码）。

**两个踩到的坑（已钉住）**：

1. **填充表是 1-based**：`SwcStyleLayer.fills[0]` 是占位符（与 SWF 的 `FillStyle0/1 == 0` 同义），
   真填充从下标 1 起。写测试夹具时忘加占位符 ⇒ `swcBakePlan` 的位图闭包变空，填充自然没有图片数组。
2. **合成器必须与 adopt 成对发射**：一开始把 `as_argb_apply_alpha` 的发射挂在
   「本构建是否真有 alpha 平面」上，但 `BitmapData_adoptEncodedAlpha` 里**无条件**调它 ⇒
   无平面的构建产出「只调用、无定义」的 C（隐式声明报错）。现为**成对发射**：
   宣称支持 alpha 的入口，就必须带上能落地 alpha 的实现。

**验收**：

- **视觉**：`temp/tkmeet-mac/d25-boot.png` / `d25-home.png`——黑矩形消失，插画透明（与 `adl` 同形）。
- **单元**：`unit: render/SwcJpeg3Alpha` **14 钉**（自造最小 SWC：SOF0「JPEG」+ 自造 alpha 平面，
  用 STORE-method ZIP 手写容器）——平面解压/取值、坏平面拒收、命名资源与填充两条路的 C 都钉住，
  含「无平面时退回原样」的反向对照。
- **回归**：全量 `node test.ts` 全绿。

---

### 9.2 F8 MovieClip 三种按钮态（`buttonMode` + `_up`/`_over`/`_down`）（阶段一百七十一，v0.4.142，diff doc D42/R29）

**现象**：TalkMED 首页两张卡片（“快速入会”/“创建会议”）以及登录按钮、九宫格图标按钮、弹窗按钮，在
`adl` 上悬停/按下都有明显的视觉反馈（首页卡片悬停改 15524 像素、按下改 105227 像素），而我们的窗口
只改了 423 / 440 像素 —— 且那点变化是调试浮层自己在动。即**全 App 的按钮反馈都是死的**。

**根因**：AIR 对「带 Flash 按钮标签的 MovieClip」有一个内建状态机：`buttonMode == true` 且时间轴上有
`_up` / `_over` / `_down` 三个 `FrameLabel` 时，指针滚入/按下/滚出会把**播放头真的移过去**
（`currentFrame`/`currentLabel` 都变，该帧的帧脚本也跟着跑）。我们只实现了 `FrameLabel` 与
`gotoAndStop`（§9.2 F6），没有这个状态机。TalkMED 皮肤里有 **29 个**这样的符号。

**AIR 实测口径（`temp/btnprobe/`：`Probe.as` 是 adl 侧探针 + `p4~p7` 截图，`Aot.as`/`Card.as` 是我们侧同一份时间线脚本）**

| 观测项 | `adl` 口径 |
|---|---|
| 门 | 是 **`buttonMode`**，不是「有标签就算按钮」：同一个类把 `buttonMode` 置 false 就永远停在第 1 帧；另一个「有标签、没有脚本」（默认 `false`）的符号（旧导出 `BtnRootResources_99复制_362`；**当前夹具** `skin_fla.BtnRootResources_99复制_64`）悬停/按下也永远停在第 1 帧 |
| 帧 | 由**标签**决定，不是帧号：旧导出 `元件17_125` 是 `_up@1/_over@4/_down@7`、`BtnRootResources_99复制_362` 是 `_up@1/_over@5/_down@10`；**当前夹具** 对位的是 `skin_fla.元件17_55`（`_up@1/_over@4/_down@7`）与 `skin_fla.BtnRootResources_99复制_64`（`_up@1/_over@5/_down@10`），各自落到自己标签那一帧 |
| 三档 | 移开 → `_up`；滚入 → `_over`；按下 → `_down`（是**真导航**，`currentFrame`/`currentLabel` 都变） |
| 按压锁 | 锁在 `mouseDown` 的那个对象上：在别处按下再拖进来只有 `_over`；在这里按下再拖出去仍保持 `_down` |
| 松开 | 指针在内回到 `_over`，在外回到 `_up` |
| 离屏 | 没有任何鼠标事件时保持 `_up` |

**实现**（`src/symbols.ts` 一字段 + `src/emit.ts` 一组助手）：

- `symbols.ts`：`InteractiveObject` 增私有 `int _btn_press_gen`（**按代际而非存指针**，故不引入新的
  GC 根，也不必担心对象先死）。
- `ASC_mouse_target`：每次绘制/指纹 pass 开头用当前 `(x,y)` 重算拾取目标（`as_mouse_refresh_target`），
  鼠标停着不动时显示列表变了也要跟得上。
- `ASC_press_gen`：`mouseDown` 时 `+1`，并把拾取目标的**祖先链**逐个盖上这个代际；判定则为
  `ASC_mouse_down && gen 匹配`。代际只增不减 ⇒ 陈旧的戳永远不会撞上后来的按压。
- `as_mc_button_state`：三道门（有烘焙时间轴 / `buttonMode` / 真的有指针）→ 选 `_down`/`_over`/`_up`
  标签（标签缺失时按 `_down → _over → _up` 退链）→ **帧号真的不同才** `as_mc_goto`（否则会把增量
  反复打一遍、把帧脚本反复跑）。
- 两处结算：绘制 pass（`as_render_object`）与**指纹 pass**（`as_render_fp`）。

**最关键的一条坑：自动烘焙会绕过绘制 pass**

祖先一旦被自动烘焙（连续 3 帧指纹相同就贴缓存图），绘制 pass 根本不会遍历到子件 ⇒ 只在
`as_render_object` 里结算状态，卡片就「帧变了、像素不动」：实测 headless 30 帧后仍是 `f=1 _up`、
像素差 **0**；同一场景 `ASC_NO_AUTO_BAKE=1` 立刻对（`f=5 _over`、差 3355 像素）。修法两条缺一不可：
① 状态也在 `as_render_fp` 里结算（它每帧都遍历每个节点）；② 指纹里混入 `MovieClip.currentFrame`，
让「状态变了但画法没变」也能让缓存失效。

**验收**

- **双端对照**：`temp/btnprobe/` 逐档帧号/标签一致（旧导出 `元件17_125` `1:_up`→`4:_over`→`7:_down`、
  按住拖出仍 `7:_down`、外面松开 `1:_up`、原地松开回 `4:_over`、别处按下再拖进来只有 `4:_over`），
  像素差同量级；`ASC_NO_AUTO_BAKE=1` 下两侧窗口的 hover/按下像素差为 16094/105076 vs adl 15524/105227。
- **示例**：`examples/swc-mc-button.as`（结构 + 8 档迁移 + 两个负例 + 首页卡片在自动烘焙下的
  `1→5→11` + 三对像素差），推进器 `--manifest examples/swc-bitmap.build.json`。
- **单元**：`unit: display/McButtonState` **15 钉**（三道门、标签退链、按压代际、两处结算点、
  指纹混帧、刷新点、示例登记）。
- **变异验证**：把 `as_render_fp` 里的那次结算删掉 ⇒ 示例 **11 处红**（含首页卡片三档）。
- **真机**：`temp/tkmeet-mac/sweep.py` 首页「快速入会」卡片悬停改 41591 像素，与 `adl` 同形；
  tabs/齿轮/用户信息三处无变化，也与 `adl` 一致。
- **回归**：全量 `node test.ts` 全绿。

### 9.2 F9 时间轴回退的**复用规则**（`_tl_char` + `as_swc_tl_rewind`）（阶段一百七十二，v0.4.143，diff doc D43/R30）

**现象**：阶段一百七十一 修完按钮态，真机验收第一眼就发现：首页两张卡片标题是 App 运行时写进皮肤
`TextField` 的（`快速入会 / Join quickly`、`创建会议 / Create Meeting`），**悬停一次再移开**就变回皮肤原稿
（`加入会议`）。

**根因**：`as_mc_goto` 的后退分支是 `as_swc_tl_clear + as_swc_bind` —— 把第 1 帧的子件**整棵重建**，
App 写在皮肤 `TextField` 实例上的文字随旧对象一起丢掉。AIR 的口径是：**目标帧仍在同一（父, 深度）上放的
是同一个角色 ⇒ 复用原对象**（属性、`text`、监听器全保留），只有角色**换了**才造新对象。

**AIR 实测口径**（`temp/btnprobe/Rewind.as` / `Rewind2.as`；我方镜像 `Rewind3.as` / `CardText.as`）

| 观测项 | `adl` 口径 |
|---|---|
| `_over(5) → _up(1)` 的子件身份 | 深度 2/3（`label1`/`label2`）编号 `#1`/`#2` **不变**，App 写的 `text` 原样保留 |
| 角色变了的那一层 | 深度 1：帧 5 的 524 → 帧 1 的 518 ⇒ 换新对象（自动实例名 `instance8 → instance28`） |
| 前进 `Move` + 新字符 | **保留原对象身份**（只换图不换实例）—— 我方仍有差（D43b） |

**实现**：`_tl_char` 下移到 `DisplayObject`（由 `as_swc_new` 统一盖章）；回退改走 `as_swc_tl_rewind`
（快照 `(父, 子件)` → 重跑帧 1 时 `as_swc_tl_reuse(父, 深度, 角色)` 认领 → `as_swc_tl_apply` 打到目标帧 →
按**对象指针**清残留）；`as_swc_tl_link` 对「已在同一父下」的对象什么都不做（不给复用对象派发多余的
`ADDED`/`REMOVED`）。细节见 §9.2 F6 的「回到旧帧的复用规则」。

**验收**：`examples/swc-mc-button.as` 第 ⑪ 档（复用 + 文字保留 + 回退后的 `_up` 与悬停前 `inkDiff == 0` +
子件数不增不减 + 变了角色的那一层确实换新对象）；`unit: render/SwcTimeline` **+7 钉**；真机
`temp/tkmeet-mac/s172labels.py` 量到**移出前后整窗（排除 FPS 浮层）0 像素差**。

**同轮登记的三处未修小缺口**：① 指针移出窗口不 roll-out（窗口后端收不到「离开窗口」，悬停态粘住）；
② `ROLL_OVER`/`ROLL_OUT`/`Stage.MOUSE_LEAVE` 事件完全不派发；③ **D43b**：前进 `Move` + 新字符在
`adl` 里是同一对象换图，我方换实例（烘焙类一个角色一个类）。

---

### 9.2 F10 SWC 符号类绑定到**工程侧基类**（阶段一百九十一，v0.4.172）

**症状**：AI 同传「设置」窗口里的两个下拉框只有边框与「▽」——没有选中文字、点击无反应。

**根因**：符号类的基类被丢弃。`skin.swc` 的 214 个 `SymbolClass` 里有 4 个（`ComBox`、
`AsrComBox`、`ComBoxSmall`、`AIAsrComBox`）在自己的 `DoABC` 里声明
`extends com.vsdevelop.controls.ComBoBox`，而 `ComBoBox`（及其基类
`com.vsdevelop.proxy.ViewControl`）**工程源码里就有**（`src/com/vsdevelop/controls/ComBoBox.as`）。
这 4 个符号类的 `DoABC` 里**没有任何帧脚本或方法**——它们的全部行为来自工程侧基类。
此前 `parseAbc` 只读实例名、把 `super_index` 那个 multiname **读掉就丢**
（`r.u30(); // base class`），于是合成类恒为 `MovieClip`/`SimpleButton` 子类：画面被烘了出来
（`as_swc_bind`），下拉框的代码却从不执行。

**修复**（三处，按数据流顺序）：

1. `abc.ts`：新增 `AbcInstance.superName` / `AbcSymbolClass.baseName`；`decodeSymbolClass`
   通过 `onBase` 回调把基类名交给调用者（**帧脚本解析失败也照报**），`decodeSymbolScripts`
   返回 `bases: Map<charId, 基类名>`，`SwcLibrary.bases` 带上它。
2. `swc.ts`：符号类声明的 `superClass` 改为「基类不是 `flash.display.*` 就用它」（短名进
   `superClass`、全限定名进 import 表，与手写 `extends` 同形）；`SwcCharacterClass.baseName`
   同步上报。构造成员仍留空体——语义层会补齐基类构造器的默认参数
   （实测 `super()` 对 `ComBoBox(maxheight = -1)` 生成 `…_ctor(o, (-1))`）。
3. `index.ts` + `reach.ts`：`computeReachable` 新增 `extraRoots`，`--air-app` 把每个 SWC 的
   `bases`（跳过 `flash.*`）作为闭包种子——**否则工程侧 `ComBoBox.as` 根本不被编译**
   （源码只按 SWC 侧类名引用，可达性看不到这条边）。SWC 解析同时缓存为 `swcLib()`，
   闭包与发射阶段共用一次解析；命令行 `--swc` 也必须计入种子（它比 reach 更晚合并进
   `cfg.swcPaths`）。

**实测**（应用自身构建，`bin-aot/build-aot.bat` 配方）：可达源 619 → **620**（多出的正是
`ComBoBox.as`）；生成的 C 中

```c
static void AIAsrComBox_ctor(AIAsrComBox* o) {
  AIAsrComBox* this = o;
  com_vsdevelop_controls_ComBoBox_ctor((com_vsdevelop_controls_ComBoBox*)o, (-1));
  as_swc_bind((DisplayObject*)o, 230);
}
```

（修复前为 `MovieClip_ctor((MovieClip*)o);`），4 个符号类全部如此；其余 192 个 `MovieClip`
符号与 2 个 `SimpleButton` 符号**逐字未变**。

**仍然堵着的**：库**自有**的一般类代码（`ScrollIndicator`/`MHIOSScrollBar`、库版 `ViewControl`
等）依旧不执行——我们只发射符号类、只执行符号类的帧脚本，SWC 的通用 ABC 不在范围内（§3.3）。
符号类若绑定到**工程里没有**的库类，语义层以 `unknown superclass` 报错，不静默降级。

**回归**：新增 `unit: swc/BaseClassBinding`（当时 14 钉，含内存库的行为钉；后于 §9.2 F11 扩到 34 钉），`unit: reach/wiring`
新增 2 钉；两态变异实测（`temp/swcgap/mutate-base.cjs`）两条全部命中，`src/swc.ts` 还原后
sha256 一致。

**交互复核（阶段一百九十二补测）**：下拉框的**交互**已在本机取证（真机 AOT 构建）——
点开「识别语言」列出全部语言（中英混合/中文/英文/日文/粤语），点「英文」后该行变为「英文」、
列表收起。即 `comboxboxstart` → `ComBoxlist` itemSkin → `MHIOSScrollBar` → `myclickComplete`
整条链路跑的都是工程侧基类代码。见 §9.2 F11。

### 9.2 F11 SWC 符号类的 `dynamic` 必须**照抄 ABC**，不能从基类继承（阶段一百九十二，v0.4.173）

**症状**：F10 落地后，AI 同传窗口点「创建同传」抛
`Error #1069: Property title not found on AIAsrComBox and there is no default value`，
窗口建到一半就停住（从用户视角看像卡死）。

**根因**：F10 把符号类的基类从 `flash.display.MovieClip` 换成工程侧的
`com.vsdevelop.controls.ComBoBox`（`extends ViewControl extends Sprite`，**sealed**），
而合成类的 `dynamic` 标志此前是**从基类继承**的（`symbols.ts`：
`if (!info.isDynamic && sup?.isDynamic) info.isDynamic = true;`）。`MovieClip` 是 dynamic
⇒ 修复前每个符号类都**顺带**拥有一张 `_dyn` 动态属性表，`as_swc_child_name` 才能把烘焙出的
具名子件（`endmc`/`btndown`/`title`）写进去；基类换成 sealed 之后这张表没了，
`as_swc_child_name` 一进门就 `return`，基类里的 `this["title"]` 于是落到 `as_dyn_get` 的
sealed 分支 → `#1069`。

**为什么报的是 `title`，而不是更早访问的 `endmc`**：`ComBoBox.addTostage` 的顺序确实是
`endmc` → `btndown` → `title`，但 `addTostage` 挂在 `ADDED_TO_STAGE` 上，而
`CreateAiSubTitleView.as` 是

```as3
targetList = new AIAsrComBox();
targetList.dataProvider = LanguageName;
targetList.selectData = targetList.dataProvider[0];   // ← 先跑：setter 里 this["title"].text = …
skin.addChild(targetList);                            // ← ADDED_TO_STAGE 在后面
```

`selectData` 的 setter 里那次 `this["title"]` 是**第一个真正执行**的动态查找，所以报的是 `title`。

**AVM2 的真规则**（不是推断）：`InstanceInfo.flags` 的 bit 0 = sealed、bit 2 = interface，
**两者都没有就是 dynamic**；bit 3（`0x08`）是 `protectedNs`，不是 sealed。实测 `skin.swc`
的 254 个类：**198 个带 `DoABC` 的符号类全是 `0x08`（dynamic）**，而库自有的
`com.vsdevelop.controls.ComBoBox` 是 `0x09`（sealed + protectedNs）。所以 `dynamic` 是符号类
**自己的** trait，必须照抄：从基类推断会把 `SimpleButton`（sealed）基类的按钮符号悄悄弄成 sealed。

**修复**（`src/abc.ts` + `src/swc.ts`）：`AbcInstance` 增加 `flags`；`AbcSymbolBase` /
`SwcCharacterClass` 由 `{基类名}` 扩成 `{baseName, dynamic}`，`decodeSymbolClass` 按
`(inst.flags & 0x05) === 0` 上报；合成类的 `isDynamic` 直接用这个值，不再交给继承逻辑兜。

**实测**（应用自身构建，`bin-aot/build-aot.bat` 配方）：

```c
static void AIAsrComBox_ctor(AIAsrComBox* o) {
  o->_dyn = as_object_new();
  gc_write_barrier((void*)o->_dyn);
  AIAsrComBox* this = o;
  com_vsdevelop_controls_ComBoBox_ctor((com_vsdevelop_controls_ComBoBox*)o, (-1));
  as_swc_bind((DisplayObject*)o, 230);
}
```

vtable 由 `… NULL, -1, "AIAsrComBox", 0, 0, 0, …` 变为
`… (int)offsetof(AIAsrComBox, _dyn), "AIAsrComBox", 0, 1, 0, …`（`dyn_offset` 不再为 −1、
`isDynamic=1`）；4 个 ComBox 族符号类（`ComBox`/`AsrComBox`/`ComBoxSmall`/`AIAsrComBox`）全部如此。

**真机复核**（真机 AOT 构建，`temp/task4/`）：点「创建同传」不再抛异常（stderr 零 `Uncaught`）；
创建窗口正常渲染；两个下拉框显示已选值（「中英混合」/「中文」）；点开下拉框列出全部语言；
选中「英文」后识别语言变为「英文」、列表收起。

**回归**：`unit: swc/BaseClassBinding` 由 14 钉扩到 **34 钉**，新增内容是 ABC 的 flags 读取与
`(flags & 0x05) === 0` 推导、`isDynamic: dynamic`、`_dyn` 结构体槽 + vtable `dyn_offset` +
`as_swc_child_name` 的 sealed 守卫，以及三条**源码 → C** 行为钉（合成类 ctor 里有
`_dyn = as_object_new()`、跑工程基类 ctor、再 `as_swc_bind`；`probeBtn` 以 `SimpleButton`
为基类而 vtable 仍带 `offsetof(…, _dyn)` —— 这条**只有**照抄 ABC 才成立；以及
「声明 sealed 但继承 dynamic `MovieClip` 的符号仍带表」这条，正是当初掩盖该 bug 的继承行为）。
6 条两态变异全部命中（`temp/task4/mutate.cjs`），`src/swc.ts`/`abc.ts`/`emit.ts`/`runtime.ts`
还原后 sha256 逐一一致。

### 9.2 F12 逐帧 `clipDepth` 遮罩：活对象引用 + 每帧重建 stencil（阶段三百一十九，v0.4.280）

**问题**：`clipDepth` 遮罩此前在**烘焙期**被算成一条静态轮廓 `_clip_path`（子件局部像素），
只能表达「帧 1 的那个遮罩、那个位置、那个几何」。`skin.swc` 里三种真形态因此全错：

| 形态 | 例（`lib/skin.swc`） | 旧行为 |
|---|---|---|
| morph 当遮罩 | `skin_fla.元件77_50` depth 2 = `char70`(morph) `clipDepth=4` | 一句 `notes` 报明 ⇒ **整块被裁空**（stencil 为空），同深度兄弟全消失 |
| sprite 当遮罩 | `char127`(sprite) `clipDepth=5` | `notes` 报明 ⇒ 无裁剪 |
| 帧尾换字符 | 同上 sprite 帧 100 把 depth 2 换成 `char73`(shape)，`clipDepth` 仍是 4 | 记录被 `continue` 丢掉 ⇒ **既不换字符也不重建遮罩**，`numChildren` 4→3 |

**做法**（`src/swc.ts` → `src/emit.ts` → `src/symbols.ts`）：

1. 烘焙只记**深度**：`SwcBakePlacement.mask = { charId, depth }`（`placement.mask` 不再带矩阵），
   `SwcBakeFrameOp` 增加 `mask?: { depth, clipDepth }` / `maskOff?: number`；区间表
   `maskRanges` 改为**每个 sprite 一份**（放进 `spriteFrames` 函数体）。
2. 帧 1 装配后，`emitSwcMaskWiring` 在**子件全部建好之后**再走一遍，把
   `child->_clip_src = <遮罩对象>; gc_write_barrier(child);`（`_clip_src` 是 `DisplayObject*`，
   进 props 反射表 ⇒ GC 会走它）。帧 2..N 由 `as_swc_tl_mask(parent, maskDepth, clipDepth)` 改写，
   区间按 SWF 规范 `(maskDepth, clipDepth]`，`clipDepth <= 0` = 退订（换字符/删除都走这里）。
3. 渲染侧 `as_render_object` 在 `save` 之后、对象 `translate` **之前**取
   `as_clip_path(o->_clip_src)`：`as_do_matrix(mask)` + `as_mask_ink` + `as_skia_path_close_all`。
   遮罩活在**父空间**（它是被遮对象的兄弟），所以只用遮罩自己的 placement 矩阵。

**根因二（才是「整块被裁空」的真凶）**：stencil 必须只是遮罩**会上色**的几何。morph `#70` 的
`Graphics` 里除填充组外还有一组`stroke` 宽度为 0 的描边，轮廓与填充**完全重合**；两条等高轮廓在
stencil 里互相抵消（even-odd 无条件抵消；改成 nonzero 也**没有**救回来，实测），于是 stencil 变空
⇒ 被遮兄弟全被裁掉。修法：`as_mask_ink` 只收集 `fill != NULL || stroke_width > 0` 的组（顶层
`g->path` 同守卫），每组至多加一次。

**实测（`adl` 51.4.1 vs AOT，像素签名为遮罩子件独有的 teal `0x00948c` 计数）**

| 探针 | `adl` | AOT（修后） |
|---|---|---|
| `loginskin`（纯 shape 遮罩）整块 ink | `177000 px` | `177000 px`，bbox 差 1px 抗锯齿 |
| `元件77_50` 帧 1，遮罩 `x=0` / `x=40` | `0` / `0`（`x=40` 时窗口露出 `88` 宽） | `0` / `194`（同样随 `x` 平移 `10 px / 20 px`） |
| 帧 1 vs 帧 99（morph ratio 0 → 1） | **两者相同**（只有帧 100 换 `char73` 才变） | 帧 99 窗口右移（比例 64874/65535） |
| 帧 100 `numChildren` / 遮罩 `x=100` | `4` / `0 px` | `4` / `0 px` |

**★ 已知偏差（如实报明，不静默）**：`adl` 的 `clipDepth` stencil 对 **morph 遮罩不跟随 ratio** ——
`Teal2` 探针里 `gotoAndStop` 到 1/2/3/5/10/20/50/80/99 的 teal 分布**逐字节相同**，只有帧 100
换字符后才变；而 AIR 自己**画**这个 morph 时是按当前 ratio 画的（阶段三百一十七的像素对照）。
我们选择让 stencil 跟**当前**几何走（遮罩与画面自洽）。同一探针的 AOT 侧因此帧 99 与帧 1 不同。
若将来要复刻 AIR 的「冻结起始形」，做法是给 `as_clip_path` 的 morph 分支换用 `_mdecl` 声明盒
矩形 `[-92.9,-10 .. 0.0,31.6]`（`as_swc_morph_70` 的 `as_swc_clip` 一侧），实测该矩形与 `adl`
帧 1 的 `clipdbg` 完全一致。

**回归**：`examples/swc-mask-frames.as`（真 `skin.swc`，帧 1/99/100 × 遮罩平移 + `loginskin`
`177000 px`）＋ `test/unit/render.ts` 的 `unit: render/SwcClipMaskPerFrame`（14 钉：烘焙只记深度、
`maskOff`/重武装两路、`_clip_src` 与 GC barrier、区间 `(maskDepth, clipDepth]`、退订清引用、
`as_clip_path` 的矩阵/闭合、`_clip_path` 彻底消失、`as_mask_ink` 的「只收上色组」）。
6 条变异全部命中（`temp/mask3/mutate.cjs`：不闭合轮廓 / 区间改闭 / 退订不清引用 / 恢复零宽描边组 /
`maskOff` 不发 / 帧 1 不 wire）。
## 10. 明确延后 / 限制

| 项 | 原因 |
|----|------|
| 运行时解码的 ±1 通道漂移（半透明像素） | Skia `readPixels(kUnpremul)` 对 straight-alpha PNG 会做预乘→反预乘两次取整，使 A∈(0,255) 的像素 RGB 漂 ±1（alpha 逐位精确）。实测 388,648 像素中 206 个不符（0.053%），均在 §11③ 允许范围内。彻底消除需自带 PNG 解码器（绕开 Skia 的 alpha 变换），代价与收益不成比例。见 §5「保真」实测修正 |
| ~~`vbitemskin`(charId 293) 的一处遮挡差异（未定位）~~ **已定位并修复**（§9.2 F3） | 根因 = `PlaceObject3` 的 `Visible = 0`（depth 6 的 #286）被解析后丢弃 ⇒ AIR 隐藏、我们画出。修后该符号 `maxdcS 76 → 30`，同批 42 个 entry 全部变好（`fileitemdoctorskin` 205 → 2 等）。残留的 30 属抗锯齿/色彩级差 |
| ~~`PlaceObject3` 的 `FILTERLIST` / `BlendMode` / `BitmapCached` 三个属性解析后丢弃~~ **已实现**（§9.2 F4，v0.4.65） | 13 条滤镜（11 Glow + 2 DropShadow）、8 条 `BlendMode`（7=`layer`、1=`darken`）、2 条 `BitmapCached` 全部落地；含 `strength` 与模糊 σ 的 AIR 对齐。1× harness 逐符号一边倒变好、无一处变差 |
| 滤镜的 `inner`（内发光/内阴影）与 `knockout` | 两者都在 SWC 记录里解析出来并进了 AS3 滤镜对象，但**光栅路径未实现**：我们一律按外发光/外阴影画。实测 `examples/embed-assets/skin.swc` 的 13 条记录 `inner = 0`、`knockout = 0`，故当前无像素影响。Skia 侧要表达「内」需要额外构造（用剪影取反 + `Blend(kSrcIn)`），未做 |
| `FILTERLIST` 里的 Bevel / GradientGlow / Convolution / GradientBevel / ColorMatrix（FilterID 3–7） | 只按文档长度跳字节并进 `swcBake.notes`**报明**，不静默丢弃；实测本库 0 条。属于「遇到再实现」 |
| 模糊剖面：我们用的是**高斯近似**，AIR 是**真 box** | 已按方差匹配（`sigma = blur*sqrt(quality)/sqrt(12)`），中心/尾部仍不同（`blur6q1` ours 217/161/94/38/9 vs AIR 191/148/106/63/21）。求真 box 需 `MatrixConvolution`（每层 36~256 抽头、非可分离），性能风险大于收益 |
| `BlendMode` 中 Skia 无法表达的模式（subtract / invert / alpha / erase） | glue 返回 0（按 `kSrcOver` 处理）并由 `notes` **报明**，不做近似 —— 实测本库 8 条全在可表达集合内（`layer`/`darken`） |
| `BlendMode.LAYER` 的语义口径 | 实现为**纯分组隔离**（`saveLayer` + `kSrcOver`）。AIR 的 `layer` 还要求该对象成为独立缓存组（等价于 `cacheAsBitmap`），本库唯一一条 `layer` 场景像素无差异，故未叠加缓存 |
| ~~被跳过的字符类型让显示列表**子件数偏少**~~ **已修**（§9.2 F5，v0.4.66） | `DefineEditText`/`DefineText`(341) 烘为空 `TextField`、`DefineMorphShape`/`2`(6) 烘为空 `Shape`，`numChildren`/`getChildAt` 索引与 AIR 一致（`minfo` 6 vs 6、`fileitemskin` 5 vs 5、`staticskin` 19 vs 19）。**残留**：① 文本占位子件没有字形/初始文本，其 `width/height` 只按声明的 `RECT` 报（实测本库 341 个 `DefineEditText` 的 `AutoSize` 全为 0 ⇒ 与 AIR 无差）；② morph 占位子件没有几何 ⇒ 3 处 `width/height` 差（`fileitemskin c2` `221.25×41.65` vs `128.35×19.55`、`元件124_72 c2` `11.75×11.75` vs `0×0`、`元件27_310 c0` `1×18` vs `0×0`） |
| 子件的**类名身份**与 AIR 不同 | AIR 对 SymbolClass 链接过的字符报**类名**（如 `popbgskin`）、对 morph 报 `MorphShape`；我们统一按基类报 `Sprite`/`Shape`（`getQualifiedClassName` 可观测）。像素与树形不受影响 |
| AIR 的包围盒**量化/累积口径**与我们不同（未定案） | 实测 `temp/childfx/` 里 33 处 `width/height` 差 `\|Δ\| ≤ 0.021px`（多数 ≤0.005，且**两个方向都有**）：例如 `userskin c4` AIR `260×30` vs 我们 `260.0006×30.0001`（同一个 280×46 的矩形 × 同一个 16.16 矩阵 scale，AIR 的值看着像是它自己的内部取整）、`homeskin c6` `354×580` vs `353.999×580.021`。两个模型的差在 0.4 twip 以内，未定案。**另**：烘焙坐标自身也有末位差（时间轴探针里文本子件 `y = 0.9500000000000002` vs `adl 0.95`，≤2 ULP，成因是两次 `/20` 相加），同样只影响字符串打印 |
| ~~时间轴 placement 的矩阵不回填到子件**自己的** `x/y/scaleX/scaleY`~~ **`x/y` 已修**（§9.2 F5，v0.4.66） | 平移现在写进子件自身 `x/y`（实测 `vbitemskin c4` `41,23.75`、文本子件 `x = tx + RECT.xmin`，均逐位相同）。**刻意保留**：2×2（scale/rotation/skew）仍只在 `transform.matrix` 里 —— F1 实测 AIR 的九宫格**不认** placement 拉伸（42 个被拉伸的 gridded entry 只有那样才对得上），故 `child.scaleX/scaleY` 我们报 1、AIR 有时报 decomposed 值（如 `popchatitem c0` `1.4973`）。像素与 `transform.matrix` 读回一致，只有直接读 `child.scaleX` 的代码可观测 |
| `ZWS`(LZMA) SWC | `examples/embed-assets/skin.swc` 是 `CWS`；布局已在 §4 给出，实现成本低，但价值有限故延后 |
| 字体（`DefineFont*`） | 需分两条路看：**app.xml 的 `<embedFonts>` 路径 `air-app.ts` 已实现**（产出清单 `font-urls` / `preload-paths`）；**SWC 内嵌字体尚未处理**——实测 `examples/embed-assets/skin.swc` 含 **7 个 `DefineFont3`**，属「从 SWC 取字体」这一独立解码域 |
| 声音（`DefineSound`） | 实测 `examples/embed-assets/skin.swc` **无** `DefineSound`（0 个）；若将来遇到，是独立解码域 |
| 被 `Sprite` 引用的无类名位图（43 个） | 需解析 `DefineSprite`/`PlaceObject` 的完整显示树；**注意 `small_gift`/`checkbom` 属于这一档**（早期版本误列为 16 个之一） |
| `[Embed]` 元数据语法 | **不是「已有捷径」**：`Embed` 目前无任何语义层消费者（§1），自有项目场景同样需要实现 |
| `DefineBitsJPEG4`（tag 90） | 实测 `examples/embed-assets/skin.swc` 无；与 JPEG3 同族（tag 35 **已支持**，§3.2③），随手支持即可。**注意**：`CHARACTER_TAG_KINDS` 已把它归为 `bitmap`，但提取器只处理 20/21/35/36 ⇒ 真遇到 tag 90 会在 `swcBakePlan` 的位图分支上以一句**误导性**的 `bitmap fill references missing bitmap #N` 失败（应按 JPEG4 报明） |
| ~~九宫格缩放（`DefineScalingGrid`，实测 22 个）~~ **已实现**（§9 F/§9.2 F1）；但 **AS3 侧的 `DisplayObject.scale9Grid` 属性尚未实现** | 工程只从 SWF tag 烘焙九宫格，运行时**没有**可读写的 `scale9Grid` 属性（AIR 有）。即：SWF 皮肤里的缩放不会糊，但用户代码无法自己设置/查询它。 已按 §1.5 记入 `TODO.md` 的 `### 遗留待开发` |
| `BitmapData.draw(source, matrix)` 对 source **自身变换**的处理与 AIR 不同 | 实测 `adl`：给被绘对象设 `o.scaleX = 2` 在 `draw(source, matrix)` 中**无效**（只受 `matrix` 参量影响）； 我们的实现会应用它。探针因此统一改为先包一层容器再 draw。**未定案**，记入 `### 遗留待开发` |
| ~~形变 shape（`DefineMorphShape`/`2`，实测 6 个）~~ **已实现**（§3.4⑦，阶段三百一十七，v0.4.278） | 两端几何逐点插值 + `PlaceObject2.Ratio` 驱动；显示盒按 AIR 实测钉在**起始形**。morph 当 `clipDepth` 遮罩与帧尾「删旧换新」已由**逐帧遮罩记录**收口（§9.2 F12，v0.4.280）。**唯一已知偏差**：AIR 的遮罩 stencil 对 morph **不跟随 ratio**（f1..f99 同框，只有帧 100 换字符才变；实测见 F12），我们跟随当前 ratio —— 见下条 |
| ~~按钮四态（`DefineButton2`，实测 29 个）~~ **已实现**（§9 F/§9.2 F2） | `ButtonRecord.states` 位掩码 + 绘制时状态机（`as_sbtn_state`）；离屏与 `adl` 逐像素一致 |
| 时间轴动画（`DefineSprite` 多帧 + `FrameLabel`）~~ **已实现**（§9.2 F6，v0.4.68） | 逐帧差值（增/替/改/删）在编译期烘焙，`gotoAndStop`/`nextFrame`/`prevFrame`/`currentLabels` 与 `adl` 逐项一致（68 行 0 差异）；79 个多帧 sprite / 514 个 op / 89 条 `FrameLabel`；回到旧帧按「同一 (父, 深度, 角色) 复用子件」对齐（阶段一百七十二，D43）。**残留**：① 时间轴子件的 `name` 恒 `null`（AIR 自动命名 `instanceN`，SWF 记录里没有 `Name` 字段）；② 帧脚本（DoABC）**自 v0.4.127 起由编译期解码并真的执行**（§3.3 收口）—— 皮肤符号里的 `stop()` 就是文件里写着的，执行它才是对齐 AIR（此前「一律停在第 1 帧」的那条旧描述已作废）；③ morph 时间轴的 `Ratio` 记录被丢弃（morph 是空占位子件）；④ 前进方向「`Move` + 新字符」AIR 保留原对象身份而我方换新对象（D43b，烘培类一个角色一个类所致） |
| MovieClip 按钮态的**结算时机** | 三种按钮态在**绘制/指纹 pass** 结算（与 `as_sbtn_state` 同一口径），因此一个从不 `render`、也没有窗口的离屏程序里，`dispatchMouse` 之后 `currentFrame` 不会自己变；真实 App（窗口每帧走这条 pass）与 `stage.render` 下行为与 `adl` 逐档一致（§9.2 F8） |
| **SWC 内嵌代码（ABC 字节码）** | **原来划为范围外、现已部分落地**：实测 255 个 `DoABC` = 254 类 / 54,162 B 字节码，容器读取已解（§3.3.1，255/255 round-trip 自证）。**v0.4.127 起符号类的帧脚本会在编译期解成 AST 并执行**（§3.3 收口：110 段帧脚本、真应用的勾选框/按钮皮肤因此真的切帧）；剩下的**一般类方法**（TweenLite/StringCore…）→ 可编译产物仍需**反编译器或 AVM2 解释器**，属另行立项。现实形态 =「资源取自 SWC，代码来自 `.as`」，并用 `<dep>` 做编译期诊断（§3.3.3）。**实测只有 mx/flex 8 个类（3,135 B）缺源码**，手写即可（§3.3.0） |

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