# `[Embed]` 资源（阶段一百一十二，v0.4.85）

> 本文记录 `[Embed]` 在**本编译器**里的实现边界、实测依据与已知偏差。
> 语义基线一律是 **adl 51.4.1**；每一条「AIR 如此」都有可复现的探针
> （`temp/embedprobe`…`temp/embedprobe7`）。实现位置：
> [`src/embed.ts`](../../src/embed.ts)（资源展开）+ [`src/emit.ts`](../../src/emit.ts)
> 的 `emitEmbedResources`（字节与绑定助手）+ [`src/swc.ts`](../../src/swc.ts)
> 的同类资源通道（SWC 命名资源，阶段九十五）。

## 1. 它是什么

AIR 的 `[Embed]` 元数据把一个**外部文件**编译进产物，并且让**被标注的类成员
本身**变成「资源类」——即该成员的值是一个 **Class**，`new <成员>()` 得到资源
对象：

```as3
public class Assets {
  [Embed(source="sky.jpg")] public static var Sky:Class;
}
var bmp:Bitmap = new Assets.Sky();   // 解码后的图
```

这是 AIR 应用分发贴图/音频/着色器字节的标准手段，也是 away3d 的
`Basic_SkyBox`（6 张天空盒 JPEG）与 `EnvMapMethod`（`RayTriangleKernel.pbj`）
赖以启动的前提。

## 2. AIR 实测（adl 51.4.1）

| 声明 | 生成的类 | 实例 |
|---|---|---|
| `.png`/`.jpg`/`.jpeg`/`.gif`/`.bmp` | `extends flash.display.Bitmap` | 有 `bitmapData`（解码后的 `BitmapData`） |
| `mimeType="application/octet-stream"`（任意扩展名） | `extends flash.utils.ByteArray` | 内容 = 文件字节**原样**（`length` = 文件大小、`position` 0） |
| `.mp3` 或 `mimeType="audio/mpeg"` | `extends flash.media.Sound` | `.length` = 真实解码时长（毫秒）、`bytesTotal` = 文件大小 |

其余实测结论（逐条都有探针）：

- **构造器 0 参**：`new C(0, 0)` ⇒ `ArgumentError #1063`（"Expected 0, got 2"），
  不是「静默忽略多余实参」。
- **`mimeType` 覆盖扩展名**：`source="a.png" mimeType="application/octet-stream"`
  ⇒ `ByteArray`；`source="a.xml"`（无 `mimeType`）⇒ `Object`（**不是** `XML`），
  而 `source="a.xml" mimeType="application/octet-stream"` ⇒ `ByteArray`。
- **`source` 路径**：相对**声明它的 `.as` 文件所在目录**；以 `/` 开头则相对
  **source root**（`--air-app` 时为 `<appRoot>/src`）。Basic_SkyBox 的两个
  `pbj` 写的就是 `/../pb/RayTriangleKernel.pbj` 这种形式。
- **去重**：同一 `(文件, mimeType)` 嵌入多次 ⇒ **只有一个类对象**（AQIR 里
  `A === B` 为真）。
- **硬拒绝**（`mxmlc` 直接报错，不是运行期）：`.txt`/`text/plain`、`.svg`、
  `.wav`、`application/xml`。AIR 的 SVG/文本通道属于**创作期转换**，不在运行时范围。
- **Class 值与实例的关系**：`var x:* = Assets.Sky; x is Class` 为真，而
  `x is Bitmap` 为**假**（实例才是 Bitmap）；`getDefinitionByName(getQualifiedClassName(Assets.Sky)) === Assets.Sky`
  为真。away3d 的 `Cast.bitmapData()` 正是靠这一对判定分支的。

## 3. 实现形态

`[Embed]` 走的是与 SWC 相同的「**资源展开前置遍**」：

```
lexer → parser → parser 保留 `[Embed(...)]` 为 Metadata.named / Field.metadata
      → embed.ts 展开（产生 AST + 字节，不产生 C 文本、不碰构建）
      → codegen（新类参与符号收集 / vtable / 类注册表）
      → emit.ts 把字节写成 C 数组 + 每个种类一个绑定助手
```

- **字节原样内嵌**：`static const unsigned char <sym>[]`，内容是**原始文件**。
  图片在运行期经 Skia（`as_skia_image_decode_bytes_argb`）解码为**直通 ARGB**
  快照，因此 opaque 像素与 AIR **逐像素一致**；半透明像素有**已知偏差**（见 §4）。
- **每个种类一个绑定助手**（`as_embed_bitmap_fill` / `as_embed_ba_fill` /
  `as_embed_sound_fill`），在生成类的**构造器**里调用；`bitmap` 类用
  `BitmapData_adoptEncoded`（与 SWC 位图同一套解码路径，无新增解码代码）。
- **生成类名**：`Embed_<宿主类 C 名>_<字段名>`。AIR 的 `<file>_<ext>$<hash>`
  里的 hash 不可复现，所以只差 `getQualifiedClassName()` 的字符串。
- **去重键** = `(解析后的文件, 种类)`，与 AIR 的「同资源一个类对象」一致。
- **字段初始化**在符号层注入（`SymbolTable.embedFieldInits`），不改 AST。
- **`source` 解析**与 AIR 同规则（声明文件目录 / 前导 `/` 为 source root）。

## 4. 已知偏差（全部显式，不静默）

| 偏差 | 说明 |
|---|---|
| 类名字符串 | `getQualifiedClassName(Assets.Sky)` 得到 `Embed_Assets_Sky`，AIR 得到 `<file>_<ext>$<hash>`（hash 不可复现）。类对象身份、`is Class`、`new` 行为、`bitmapData` 全部一致 |
| 半透明像素 | AIR 会把半透明像素的 RGB 反预乘后存 **bitmapData**（实测其为 `(c,a)` 的确定函数、但不是一对干净的预乘/反预乘）；我们存**直通 ARGB**。opaque 像素逐像素一致 |
| 内嵌音频 | 生成的是真正的 `Sound` 子类，解码交给音频后端；**没有**音频后端的构建里 `loadCompressedDataFromByteArray` 返回 −1 ⇒ `#2068`（与 AIR 在有设备时的行为不同，但这是后端能力而非 `[Embed]` 语义） |
| 拒绝集 | `.txt`/`.svg`/`.wav`/`application/xml` 与 AIR 一样拒绝；未知扩展名/`mimeType` 也会**响亮报错**并列出支持集（§1.5 绝不静默） |
| **编译范围 = 整个 `src/`** | 我们**不做可达性分析**：`<appRoot>/src` 下每个 `.as` 的 `[Embed]` 都会被打包（含**其它 demo** 的资源），且会**存活进产物**；`mxmlc`/`adl` 是**传递编译**、只处理可达类的 `[Embed]`。连带后果：不可达类里的坏 `[Embed]` 让我们**编译期失败**。实测与判据见 **§7**，已入 `TODO.md` 遗留表 |
| 声音的 `extract`/`id3` | 依赖音频后端能力，见 `docs/zh-cn/audio.md` |

## 5. 用法

`[Embed]` 的图片要**解码**，所以构建清单必须链上 Skia（与 SWC 位图同理，
这是**构建层**的选择，不是 codegen 的）：

```bash
node src/index.ts my-app.as --manifest my.build.json --run
```

`examples/embed.as` + `examples/embed.build.json` 是完整样例（覆盖 image /
binary / sound 三种资源、Class 值同一性、去重、`new C(0,0)` 的 #1063、
解码后的像素值），由 `node test.ts` 的 `example: embed.as` 用例守护；
`test/unit/embed.ts` 钉住源级结构与负例文案。

## 6. 证据与复现

- `temp/embedprobe*`：adl 探针（种类表、0 参构造器、`mimeType` 覆盖、
  路径规则、去重、拒绝集），结论落盘在 `temp/embedprobe7/adl.txt`。
- `examples/away3d-core/Basic_SkyBox.as`：6 张天空盒 JPEG，headless 运行时
  窗口渲染出雪山天空盒 + 环境反射铬环（见 `docs/zh-cn/display3d.md` §9）。
- 静态实现位置：`src/embed.ts`（展开）、`emit.ts` 的 `emitEmbedResources`
  （字节与绑定助手）、`test/unit/embed.ts`（源级钉子，3 组）。


## 7. 编译范围：谁的内嵌会被打包（已知偏差）

**AIR 侧是传递编译**：`mxmlc` 从主类出发（`-source-path+=src` + `$MAIN_SRC`），
只处理**可达类**里的 `[Embed]`（`src/air-app.ts` 的脚本注释也这么写着：
「AIR/mxmlc compiles transitively from the main class」）。

**我们是整包编译**：`--air-app` 的 `walk(srcDir)` 把 `<appRoot>/src` 下**所有** `.as`
都收进编译（只有 `SKIP_FILES` 与反向域名目录 `com/org/net` 除外），**没有可达性分析**；
`src/index.ts` 的 `collectEmbeds` 对**每个**已解析文件跑一遍嵌入展开 ⇒
**每一个** `[Embed]` 都变成资源。away3d-core 的两个主程序都因此拿到
**40 个资源 / 4,969,434 B（4.74 MB）**：

```
[1/4] read   examples/away3d-core/Basic_SkyBox-app.xml (main Basic_SkyBox, 485 sources)
      embed  40 asset(s)
              image  Basic_SkyBox.EnvPosX <- ../embeds/skybox/snow_positive_x.jpg (107566 bytes)
              ...
              image  Basic_SpriteSheetAnimation.testSheet1 <- ../embeds/spritesheets/testSheet1.jpg (19455 bytes)
```

注意最后一行：`Basic_SkyBox` **并不用**精灵表，但它的资源照样进了这次构建。
（`Basic_SkyBox.as` 自己只声明 6 张天空盒 JPEG；`Basic_Stereo.as` **一个都不声明**。）

### 这些资源会活到产物里

不只是编译期多干活，它们**真的进二进制**：`emitClassRegistry` 的
`as_class_registry[]` 引用**每个**类对象（嵌入类也在内），而
`src/away3d/utils/Cast.as:254` 的 `getDefinitionByName` 让
`as_get_definition_by_name` 成为可达符号 ⇒ 注册表活在闭包里 ⇒
**`-O2` 剪不掉**嵌入工厂与内嵌字节数组。

**判据是二进制字节**（各取 48 字节中段，`Basic_Stereo` 完全不用这四个资源）：

| 资源 | 字节 | `Basic_SkyBox` 中出现次数 | `Basic_Stereo` 中出现次数 |
|---|---|---|---|
| `embeds/road.jpg` | 55,879 | 1（不用） | 1（不用） |
| `embeds/rockbase_normals.png` | 584,811 | 1（不用） | 1（不用） |
| `embeds/hellknight/idle2.md5anim` | 292,064 | 1（不用） | 1（不用） |
| `embeds/skybox/grimnight_posX.png` | 57,507 | 1（用） | 1（不用） |

对照 **SWF 体积**（AIR 传递编译的产物只带自己那几份）：

| demo | 自己的资源 | `mxmlc` 出的 `.swf` |
|---|---|---|
| `Basic_Stereo` | **0 个** | **94 KB** |
| `Basic_SkyBox` | 6 张天空盒 JPEG（645,180 B） | 746 KB |
| `Basic_UVAnimation` | 2 个（326,601 B） | 421 KB |
| `Intermediate_MD5Animation` | 多个 md5/贴图 | 2.71 MB |

若 40 个资源都要进，任何一份 SWF 都该 ≥4.6 MB。

### 连带后果：不可达类里的坏 `[Embed]` 让我们编译期失败

一个**其它** demo（或压根没人调用）的类里写着指向不存在文件的 `[Embed]`，
`adl` 构建无恙（那个类不在闭包里），我们却会**响亮失败**。
这是**保真缺口**（AGENTS.md §1.5：`adl` 能跑对而我们跑不出 ⇒ 遗留），
不是增强，已登记在 [`TODO.md`](../../TODO.md) 的 `### 遗留待开发`。

> 修的时候注意：**别顺手把 `as_class_registry[]` 变懒**——它同时服务
> `x is SomeClass`、`new x()` 的动态路径、`getDefinitionByName()` 与 GC 根；
> 依赖 `[Embed]` 的程序（`Basic_SkyBox`）与依赖反射的程序（`Cast.bitmapData`）
> 必须都继续正确。当前这个偏差是**显式的**（构建日志逐条列出资源），
> 不是静默行为。