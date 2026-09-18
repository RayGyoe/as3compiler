# SWC 资源提取与嵌入方案

> 本文回答一个问题：**纯 AS 项目把图片等资源打进 SWC，AOT 编译器怎么把这些资源取出来、显示到 UI 上**。
> 核心结论先行：SWC 是 ZIP 归档，但资源**不是 ZIP 里的独立文件**，而是被 mxmlc 编译进 `library.swf`，
> 以 SWF 二进制 tag 形式存放（位图 → `DefineBitsLossless2`/`DefineBitsJPEG2`，经 `SymbolClass` 映射到类名）。
> 因此「解析 SWC 拿资源」= **ZIP 解包 → 解压 SWF → 扫描 tag 流 → 提取位图像素/JPEG 字节**。
> 这条链路在**编译期**（Node 侧，零第三方依赖）完成，把资源转成 C 字节数组嵌入产物；
> 运行时的解码显示复用已有的 Skia 后端（`BitmapData.loadFile` 同款 `MakeFromEncoded` 路径），零新增。
>
> 本文所有结论均基于对真实 `temp/skin.swc`（743 KB，255 个类，59 个位图资源）的解包实测，
> 不是文档转述。

---

## 1. 为什么这个需求存在：纯 AS 项目里 SWC 是资源载体

在 Flash/Flex 生态里，资源（皮肤位图、图标、字体）有两种归属：

| 场景 | 资源存放 | 提取难度 |
|------|---------|---------|
| 自有项目 + `[Embed(source="a.png")]` | 原图还在源码目录 | 低——直接读原图，**根本不用碰 SWC** |
| 第三方库 / Flash IDE 导出的皮肤库 | 原图不可得，只有 `.swc` | 高——必须解 SWC + 解 SWF |

用户场景是后者：`temp/skin.swc` 是一个 Flash IDE 导出的 UI 皮肤库（含 `logo`/`imgback`/`desktopicon`/
`cambitmap` 等资源类），原图已丢失，只能从 SWC 里提取。

---

## 2. SWC 的解剖：ZIP 外壳 + 内嵌 SWF

把 `.swc` 后缀改成 `.zip` 解压，标准结构只有两个文件（`docs/` 是可选的 ASDoc 文档）：

```
skin.swc (ZIP 归档)
├── catalog.xml      84 KB   —— 组件目录：<script> 列出每个类及其依赖（<dep>）
└── library.swf     737 KB   —— 编译产物：SWF 容器（CWS = zlib 压缩）
```

`catalog.xml` 的结构（实测 `temp/skin.swc`）：

```xml
<swc xmlns="http://www.adobe.com/flash/swccatalog/9">
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
`library.swf` 里。

---

## 3. 资源的真实存放形式：SWF tag

`library.swf` 是标准 SWF 容器，头 8 字节 `CWS` 表示 zlib 压缩（`FWS`=未压缩、`ZWS`=LZMA）。
实测 `temp/skin.swc` 的 `library.swf` 是 **CWS**。解压后是 tag 流，每个 tag 由
`(code:length) 头 + 数据体` 组成。

资源相关的 tag（实测 tag 类型分布）：

| `[Embed]` 类型 / 资源 | SWF tag | tag code | 数据体内容 |
|---|---|---|---|
| PNG/无损位图 | `DefineBitsLossless` | 20 | SWF 自有位图格式（见 §3.1） |
| PNG/无损位图（新版） | `DefineBitsLossless2` | 36 | SWF 自有位图格式（见 §3.1） |
| JPEG | `DefineBitsJPEG2` | 21 | `characterID` + **完整 JPEG 字节**（`FF D8` 开头） |
| JPEG（带 alpha） | `DefineBitsJPEG3/4` | 35/90 | JPEG + alpha 数据 |
| 原始字节 | `DefineBinaryData` | 87 | `characterID` + 原始字节 |
| 字体 / 声音 | `DefineFont*` / `DefineSound` | 10/48/14 | 字体/音频数据 |
| **symbol → 类名** | `SymbolClass` | 76 | `{id → "类名"}` 映射 |

实测 `temp/skin.swc` 的 `library.swf` 有 **59 个位图 tag**（`DefineBitsLossless2`×53 +
`DefineBitsLossless`×1 + `DefineBitsJPEG2`×3 + `DefineBitsJPEG3`×2），`SymbolClass` 里 **214 条映射**。

### 3.1 重要陷阱：`DefineBitsLossless` 存的**不是 PNG**

这是最容易踩的坑。`DefineBitsLossless2` 的数据体**不是** PNG 文件，而是 SWF 自定义的位图格式：

```
DefineBitsLossless2 数据体：
  characterID   u16   （symbol id）
  bitmapFormat  u8    （3 = 8bit 带色表；4 = 15bit RGB；5 = 32bit ARGB）
  width         u16
  height        u16
  [colorTableSize u8]  （仅 bitmapFormat==3）
  zlibData      ...   （zlib 压缩的像素数据）
```

实测提取 `symbol#2`（`logo`）：`characterID=2, format=5(32bit ARGB), 100×72`，解压后像素
`28800 字节 = 100×72×4`，前 16 字节全 0（透明边缘），非零像素占 37.1%——是有效图片内容。

**结论**：`DefineBitsLossless2` 需要「解 zlib → 得到原始 ARGB/RGB 像素」，**不能**直接喂 Skia 的
`MakeFromEncoded`（它只认 PNG/JPEG 等编码格式）。而 `DefineBitsJPEG2` 存的**就是完整 JPEG**，
可直接喂 Skia。

---

## 4. 编译期提取链路（已端到端验证）

```
SWC (ZIP)
  │  ① 手写 ZIP central directory 解析（Node 侧，零依赖）
  ▼
library.swf (deflate 压缩的 CWS 文件)
  │  ② zlib raw-inflate 解 ZIP 层 → 得到 CWS 文件字节
  ▼
CWS 文件（"CWS" + version + fileLength + zlib 流）
  │  ③ zlib inflate 解 CWS 层 → 得到 SWF tag 流
  ▼
tag 流（header 解出 code:length，逐 tag 扫描）
  │  ④ 命中 DefineBitsLossless2(36)/Lossless(20)/JPEG2(21)/JPEG3(35)
  ▼
位图资源：
  ├─ Lossless2 → zlib 解压 → 原始 ARGB 像素（+ 宽高）
  └─ JPEG2/3   → 完整 JPEG 字节（+ alpha）
```

**验证结果**（真实 `skin.swc`，`symbol#2 logo`）：

```
① ZIP 层 deflate 解压: 737700 字节 → CWS 737552 字节
② CWS 层 zlib 解压:    → SWF body 1031069 字节
③ Lossless2 提取:      characterID=2, format=5(32bitARGB), 100×72, 28800B 像素
④ 有效内容 37.1% 非零 —— 提取正确
```

**零第三方依赖的可行性**：ZIP 的 central directory 结构（`PK\x01\x02` 头 + `PK\x05\x06` EOCD 尾）
手写解析约 30 行；zlib 解压用 Node 内置 `zlib.inflateSync`/`inflateRawSync`；SWF tag 扫描约 40 行。
全部在编译前端（Node 侧）完成，符合 AGENTS.md §3.1「零第三方依赖」。

---

## 5. 资源 → 产物：编译期嵌入的两种策略

用户已确定**编译期提取、嵌入产物**（产物自包含、无外部文件依赖）。两种嵌入方式按资源格式分：

| 资源格式 | 嵌入内容 | 运行时解码 |
|---------|---------|-----------|
| `DefineBitsJPEG2/3` | JPEG 原始字节（C 字节数组） | Skia `SkImages::DeferredFromEncodedData`（已有路径） |
| `DefineBitsLossless2` | 解出的 ARGB 像素（C 字节数组）+ 宽高 | 直接填 `BitmapData.pixels`（已有 RGBA 缓冲），或转 `SkBitmap` |

JPEG 直接嵌字节、运行时 Skia 解码——与现有 `as_skia_image_from_file`（`sk_image_from_file`）完全同路，
只是数据来源从「磁盘文件」换成「内存字节数组」（新增 `as_skia_image_from_bytes(data, len)`，几行胶水）。

Lossless2 解出的 ARGB 像素直接填 `BitmapData.pixels`——项目已有 `BitmapData.getPixel/setPixel` 的
RGBA 缓冲与渲染路径，零解码。

### 5.1 嵌入形态（C 字节数组）

编译期生成一段资源段，形如：

```c
/* SWC resource: skin.swc#logo (100x72, 32bit ARGB) */
static const unsigned char __res_skin_logo[] = {
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, /* ... 28800 bytes ... */
};
static const int __res_skin_logo_w = 100;
static const int __res_skin_logo_h = 72;
```

大资源（如几百 KB 的 JPEG）嵌入会让单个 `.c` 膨胀，但这是「单文件可读 C」默认形态的自然结果；
如未来资源过大，可降级为「资源段独立 `.c` + 构建清单 `sources` 合并」——构建层已支持（§2.9）。

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

而 `SymbolClass` 里 214 条映射中，**只有 16 个位图直接映射到类名**（`logo`/`imgback`/`desktopicon`/
`cambitmap`/`small_gift`/`checkbom` 等），其余 **43 个位图没有类名**（`className` 缺失，被 `Sprite`/
`DefineShape` 作为子对象引用）。

**AS3 侧引用方式（两种，按用户代码风格分）**：

| 引用方式 | 典型代码 | codegen 落地 |
|---------|---------|-------------|
| 直接 `new 资源类(w,h)` | `var b:Bitmap = new Bitmap(new logo(0,0));` | 资源类注册为 `BitmapData` 子类，`new` 分发到「嵌入像素填充」工厂 |
| `SymbolClass` 反射 | `getDefinitionByName("logo")` | 资源注册表 `{name → 工厂指针}`，动态查表（依赖动态类实例化，阶段四十八已落地） |

**推荐先落地方式一**：把 `SymbolClass` 中映射到类名、且是 `BitmapData` 子类的资源（16 个），
编译期提取像素/字节，codegen 生成对应的 `BitmapData` 子类 + 工厂，`new logo(w,h)` 返回填好像素的
`BitmapData`。方式二（反射查表）作为后续扩展。

---

## 7. 实现落点（对齐 AGENTS.md 分层）

| 层 | 改动 | 说明 |
|----|------|------|
| **构建层 `src/swc.ts`（新增）** | SWC 提取器 | ZIP 解析 + CWS 解压 + tag 扫描 + 位图提取，产出 `SwcResource[]`（类名/格式/宽高/像素或字节） |
| **构建编排 `src/build.ts`** | `--swc` 参数 / 构建清单 `swc-paths` | 收集 SWC 依赖，调用提取器，把资源注入 codegen |
| **语义层 `src/symbols.ts`** | 资源类注册 | 把资源类名注册为 `BitmapData` 子类（`dynamic`，构造器 `(int,int)`） |
| **语义层 `src/emit.ts`** | 资源段发射 + `new` 分发 | 发射 C 字节数组资源段；`new logo(w,h)` 分发到「嵌入像素 → BitmapData」工厂 |
| **运行时 `src/runtime.ts`** | `as_skia_image_from_bytes` | 内存字节 → Skia `MakeFromEncoded`（JPEG 路径，几行胶水） |

**边界铁律**：提取逻辑（ZIP/SWF 解析）**只能**发生在编译期（`swc.ts`），**禁止**塞进 `RUNTIME_PREAMBLE`
——那会让运行时背一个 SWF 解析器，违反「前端只翻译」铁律（AGENTS.md §1.3）。

---

## 8. 与 Ruffle 的关系（复用评估）

Ruffle 的 `swf` crate 有完整的 `read_tag_with_code`（含 `DefineBitsLossless`/`DefineBitsJPEG` 解析），
**但不可移植**（Rust + `gc_arena` GC）。它的价值是**参考实现**：

- `swf/src/read.rs` 的 tag 头解析、`DefineBitsLossless2` 字段偏移（`characterID/bitmapFormat/width/
  height/zlibData`）可作为我们 `swc.ts` 手写解析器的**格式对齐基准**；
- `make_lzma_reader`（mangled LZMA header 处理）只在 `ZWS` 时有用，`temp/skin.swc` 是 `CWS`，首期不碰。

**不引入 Ruffle 代码**，只用它对齐格式细节。

---

## 9. 分阶段计划（对应用户选定的「编译期提取嵌入产物」）

### 阶段六十六：SWC 提取器 + ZIP/SWF 解析（编译期）

- [ ] `src/swc.ts`：手写 ZIP central directory 解析 + `zlib` raw-inflate 解 `library.swf` 的 ZIP 层；
      CWS 解压（`zlib.inflateSync`）得到 tag 流；扫描 tag，提取 `DefineBitsLossless2`/`Lossless`（解
      zlib → ARGB 像素）/`DefineBitsJPEG2/3`（JPEG 字节）
- [ ] `SymbolClass`(76) 解析：`{symbol id → className}` 映射；筛出「映射到类名 + 是 BitmapData 子类」的资源
- [ ] 产出 `SwcResource[]`（`className`/`format`/`width`/`height`/`pixels` 或 `jpegBytes`）
- [ ] 验收：对 `temp/skin.swc` 跑提取器，16 个类名资源全部提取、像素尺寸正确（`logo` 100×72）

### 阶段六十七：资源类注册 + 嵌入像素填充（codegen）

- [ ] `symbols.ts`：把资源类名注册为 `BitmapData` 动态子类（构造器 `(int,int)`）
- [ ] `emit.ts`：发射 C 字节数组资源段（`__res_skin_logo[]` + 宽高）；`new logo(w,h)` 分发到
      「分配 BitmapData + 填充嵌入像素 + 写宽高」工厂；JPEG 资源走 `as_skia_image_from_bytes` 解码
- [ ] `runtime.ts`：新增 `as_skia_image_from_bytes(data, len)`（JPEG 内存解码胶水）
- [ ] 验收：`examples/swc_skin.as` 里 `new logo(0,0)` + `getPixel` 断言像素非空 + 渲染出 PNG

### 阶段六十八：CLI/清单接入 + 收尾

- [ ] `build.ts` + `index.ts`：`--swc path/to/skin.swc` 参数（可多个）+ 构建清单 `swc-paths` 字段；
      提取器结果注入 codegen 的资源表
- [ ] 回归全部旧示例；README 同步「SWC 资源嵌入」支持子集与限制（ZWS/LZMA、字体、声音、SymbolClass
      反射延后）；版本号递增

---

## 10. 明确延后 / 限制

| 项 | 原因 |
|----|------|
| `ZWS`(LZMA) SWC | `temp/skin.swc` 是 `CWS`；LZMA 需 `make_lzma_reader` 的 mangled header 处理，独立子阶段 |
| 字体（`DefineFont*`）/ 声音（`DefineSound`） | 首期只做「显示 UI」所需的位图；字体/音频是独立解码域 |
| `SymbolClass` 反射（`getDefinitionByName`） | 依赖动态类实例化 + 反射表，阶段四十八已有基础，作后续扩展 |
| 被 `Sprite` 引用的无类名位图（43 个） | 需解析 `DefineSprite`/`PlaceObject` 的完整显示树，首期只做「有类名的直接资源」 |
| `[Embed]` 元数据语法 | 自有项目场景直接读原图更简单，本方案聚焦「只有 SWC」场景 |
