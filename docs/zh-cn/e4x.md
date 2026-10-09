# E4X / XML 专项调研与立项

> 本文回答一个问题：**Starling 框架大量使用 `flash.xml` 的 XML/E4X，AOT 编译器要不要做、做到什么程度、怎么落地**。
> 核心结论先行：**Starling 实际用到的 E4X 是一个很窄的子集——几乎没有裸 XML 字面量（`<root/>` 直接写在源码），
> 全部是运行时 `new XML(bytes)` / `XML(str)` 构造 + `@attr` 属性访问 + `.child` 子节点路径 + E4X 过滤谓词
> `.(@attr == value)`**。因此不需要实现 E4X 最难的「XML 字面量 + `{}` 内嵌表达式 + 命名空间字面量」，
> 只需要：① `XML`/`XMLList` 两个内建类型的建模；② 一个手写极小 XML 解析器（编译期/运行时零第三方依赖，复用 `air-app.ts`
> 已验证的极小解析思路）；③ `@` 运算符与 `.child`/`.(pred)` 后置导航的语法支持；④ `describeType` 的 XML 输出。
>
> 本文所有结论均基于对 `examples/air-starling-demo`（142 文件 / 34658 行）中 E4X 用法的逐处实测统计，不是文档转述。

---

## 1. 为什么这个需求存在：Starling 的资源加载管线依赖 XML

Starling 的资源系统（`AssetManager`/`XmlFactory`/`TextureAtlas`/`BitmapFont`）把纹理图集（atlas XML）与
位图字体（BMFont `.fnt`，本质是 XML）当作核心输入格式。`AssetManager.enqueue("a.xml")` → `XmlFactory.create` →
`new XML(bytes)` 解析 → 依据根节点名分派 `TextureAtlas`/`BitmapFont` → 用 `@attr` 读属性。**没有 XML 支持，
Starling 连纹理图集和位图字体都加载不了**，是渲染管线的硬前置。

`describeType` 也依赖 XML：`AssetManager.enqueue(Class)` 用 `describeType(asset)` 返回的 XML，遍历
`constant.(@type=="Class")` / `variable.(@type=="Class")` / `metadata.(@name=="Embed")` 提取 `[Embed]` 元数据。
二者同源——都卡在 XML/E4X 内建（TODO 阶段八十六已把 `describeType` 延后至此）。

---

## 2. 实测：Starling 用到的 E4X 精确范围

逐文件 grep（排除注释里的 `@param`/`@return`/`@see` 等 ASDoc 标签与 `Vector.<T>` 泛型尖括号），真实 E4X 用法如下：

### 2.1 构造（全部是运行时构造，无裸 XML 字面量）

| 形态 | 位置 | 说明 |
|---|---|---|
| `new XML(bytes)` | `utils/AssetManager.as:953`、`assets/XmlFactory.as:39` | 从 `ByteArray` 构造 |
| `XML(str)` | `text/MiniBitmapFont.as:187` | 从 `String` 构造（无 `new` 的函数式调用） |

**关键事实**：全仓库 grep `=<`、`return <`、`:<` 均**无裸 XML 字面量**（`var x:XML = <root/>`）。
这意味着 **lexer 无需实现 E4X 的 XML 字面量模式（最难的 `<` 状态机切换）**。

### 2.2 属性访问 `@attr`

| 文件 | 次数 | 典型形态 |
|---|---|---|
| `textures/TextureAtlas.as` | 13 | `subTexture.@name`、`subTexture.@x`、`@frameWidth` … |
| `text/BitmapFont.as` | 17 | `fontXml.info.@face`、`charElement.@id`、`kerningElement.@amount` … |
| `utils/AssetManager.as` | 11 | `xml.@imagePath`、`typeXml.@name`、`childNode.@name` … |
| `assets/AssetManager.as` | 14 | `node.@name`、`arg.@value`、`typeXml.@name` … |
| `assets/XmlFactory.as` | 4 | `xml.@imagePath`、`xml.pages.page.@file`、`xml.info.@face` |

注意：`@attr` 的**结果默认是 String**（E4X 语义：属性值自动 `toString()`），且可继续 `.toString()` 链式调用——
`xml.info.@smooth.toString() == "0"`。这是 AS3 语义，不是 C 行为巧合。

### 2.3 子节点路径 `.child`（点导航）

| 形态 | 位置 | 说明 |
|---|---|---|
| `xml.pages.page.@file` | `XmlFactory.as:69`、`AssetManager.as:770` | 多级 `.child` 后接 `@attr` |
| `fontXml.chars.char` | `BitmapFont.as:170` | 迭代目标 |
| `fontXml.kernings.kerning` | `BitmapFont.as:188` | 迭代目标 |
| `fontXml.distanceField.length()` | `BitmapFont.as:158` | 子节点存在性判断 |
| `atlasXml.SubTexture` | `TextureAtlas.as:119` | `for each (var subTexture:XML in atlasXml.SubTexture)` |

### 2.4 E4X 过滤谓词 `.(@attr == value)`（最难的部分）

| 形态 | 位置 | 说明 |
|---|---|---|
| `typeXml.constant.(@type == "Class")` | `utils/AssetManager.as:574`、`assets/AssetManager.as:271` | 过滤 constant 节点中 `@type=="Class"` 的 |
| `typeXml.variable.(@type == "Class")` | 同上 | 过滤 variable 节点 |
| `variableDeclarationNode.metadata.(@name == "Embed")` | `assets/AssetManager.as:313/331` | 过滤 metadata 节点 |
| `embedMetadata.arg.(@key == "source"/"mimeType")` | `assets/AssetManager.as:314/332` | 过滤 arg 节点 |

`.(...)` 是 E4X 的**过滤谓词**：对 `.child` 返回的 `XMLList` 做谓词筛选，返回满足条件的子集。
这是 E4X 区别于普通 DOM 的核心语义，也是落地成本最高的一块。

### 2.5 方法 / 内建

| 调用 | 说明 |
|---|---|
| `xml.localName()` | 根节点名（`"TextureAtlas"`/`"font"` 分派） |
| `xml.@attr.toString()` | 属性值转 String |
| `xml.distanceField.length()` | 子节点存在性（返回 `int`） |
| `asset is XML` / `asset as XML` | 类型判断/转换（`assets/AssetManager.as:1013`） |
| `System.disposeXML(xml)` | 显式释放（6 处，`System` 内建） |
| `describeType(x):XML` | 反射描述（2 处） |

---

## 3. AS3 E4X 语义与 C 的差异（正确性红线）

E4X 是 ES4 规范的产物，AS3 完全继承。翻译时必须显式处理的差异点：

| E4X 语义 | C 的坑 | 正确做法 |
|---|---|---|
| `@attr` 返回 `XMLList`，但标量上下文隐式 `toString()` | C 无对应物 | 建模为「XML 节点 + 属性表」，`@attr` 编译期直接展开为 `as_xml_attr(xml, "attr")` 返回 `as_value`（String）；`.toString()` 是 no-op 返回自身字符串 |
| `.child` 返回 `XMLList`（子节点集） | C 无 XMLList | 建模为 `as_xml_list`（子节点指针数组）；`.child.grandchild` 是对每个子节点取 grandchild 再展平 |
| `.(pred)` 过滤谓词 | C 无谓词 | 运行时谓词求值：`.(@name=="Embed")` → 对每个 child 查 `@name` 属性是否等于 `"Embed"`，满足则保留 |
| `for each (x in xml.child)` | 迭代 `XMLList` 而非 Array | `XMLList` 实现可迭代（复用 `as_vector` 或独立链表），`for each` 走 `as_xml_list_get(list, i)` |
| `xml.localName()` | C 无 | 每个 XML 节点存 `name` 字段 |
| `xml.distanceField.length()` | C 无 | 返回子节点数 `int` |
| `XML`/`XMLList` 是 `Object` 子类，可 `is`/`as`/`==` | 需 box tag | 新增 box tag（如 `as_v_xml`/`as_v_xml_list`），**同步补 `as_v_typeof`/`as_v_truthy`/`as_v_eq`/`as_v_str_val`/`gc_mark_value` 五处**（AGENTS.md §2.4 红线） |
| `new XML(bytes)` 从 ByteArray 构造 | 需解析 XML 文本 | 手写极小 XML 解析器（DOM 树：element/attribute/text），复用 `air-app.ts` 已验证的极小解析思路，零第三方依赖 |
| `describeType` 返回 XML | 需生成描述树 | 反射表 + 生成的 XML 树（`<type>`/`<extendsClass>`/`<constant>`/`<variable>`/`<accessor>`/`<method>`…） |

**XML 解析器的取舍**（对应 AGENTS.md §2.9「链接成熟库」铁律）：

- 候选 1：链接成熟 XML 库（libxml2/tinyxml2/expat）。优点：健壮、支持完整 XML 1.0。缺点：引入 C++/系统依赖，
  与「生成可读 C + 零第三方依赖」默认形态冲突，且 E4X 的 `.child`/`@attr`/`.(pred)` 语义仍需自研适配层。
- 候选 2（**推荐**）：手写极小 DOM 解析器（纯 C，内嵌 `RUNTIME_PREAMBLE`，零依赖）。Starling 的 XML 输入是
  **图集/字体元数据，结构规整、无 DTD/实体/命名空间**，极小解析器（element/attribute/text 三节点 + 递归下降）
  足以覆盖。`air-app.ts` 已有手写极小 XML 提取器先例（只提取 `<id>`/`<filename>` 等字段），思路已验证。

结论：**先手写极小 DOM 解析器**，覆盖 Starling 实际输入的 XML 子集；若未来遇到完整 XML 1.0 需求再评估链接库。
这与正则引擎「自研 ES3 回溯 VM」的决策逻辑一致——E4X 语义（`.child`/`@attr`/`.(pred)`）无论如何都要自研，
解析器只是其中一小块，为这一小块引入外部依赖不划算。

---

## 4. 落地状态（阶段九十~九十三，已全部完成）

| 层 | 状态 |
|---|---|
| `lexer.ts` | ✅ `@` 已识别为后置运算符（E4X 属性访问）；✅ **XML 字面量**模式（阶段一百零六 落地 `<a b="1">…</a>`：递归 name-stack 配平、注释/CDATA/PI、`{expr}` 插值**响亮拒绝**；阶段一百零八 修掉「兄弟元素之间的文本未跳过 ⇒ 缩进过的多行字面量报 `unterminated regular expression`」的扫描缺陷） |
| `parser.ts` | ✅ `expr.@attr`、`.child` E4X 导航、`.(pred)` 过滤谓词、**后代轴** `x..name`/`x..*`（阶段一百零六）、**计算名两轴** `x.ns::[expr]`（孩子轴）与 `x.@[expr]`（属性轴）（阶段一百零八，`ns` 限定词按「命名空间编译期透明」折叠丢弃）、`XML`/`XMLList` 类型注解 |
| `symbols.ts` | ✅ `XML`/`XMLList` 已建模（`kind:'xml'/'xmllist'`）；`System.disposeXML` 已建模 |
| `emit.ts` | ✅ `describeType` 真实现 `as_describe_type`（`<type name="包::类"/>` XML 树，非 Class 退回 `<type name="Object"/>`）；✅ 计算名按接收者分派（xml/xmllist → `as_xml_*`，Proxy/动态对象属性轴 → `as_dyn_get`，其余接收者**响亮** `CodegenError`） |
| `runtime.ts` | ✅ 内嵌 `as_xml_parse` 极小 DOM 解析器 + `as_xml_attr`/`as_xml_children`/`as_xml_filter`/`as_xml_descendants`/`as_xml_list_*`/`as_describe_type` 全套助手；**孩子轴按「本地名」比对**（`as_xml_local()`，阶段一百零八） |

---

## 5. 落地分层（已完成，见 TODO.md 阶段九十~九十三）

按「依赖顺序 + 每阶段可验收」拆为四个阶段，**已全部落地并回归通过**（`examples/stage90~93.as`，94 passed / 0 failed），
正式登记见 TODO.md 主路线图「阶段九十~九十三」条目（版本号未递增，`package.json` 保持 0.3.108）：

| 阶段 | 内容 | 版本 | 验收 |
|---|---|---|---|
| 九十 | `XML`/`XMLList` 类型建模 + 极小 XML 解析器 | 待递增 | `stage90.as` |
| 九十一 | `@attr` 属性访问 + `.child` 子节点导航 | 待递增 | `stage91.as` |
| 九十二 | E4X 过滤谓词 `.(@attr == value)` | 待递增 | `stage92.as` |
| 九十三 | `describeType` 的 XML 输出 | 待递增 | `stage93.as` |

> **修正（阶段一百零八）**：上面这行旧结论**已过时** —— XML 字面量与 `..` 后代轴在**阶段一百零六** 落地（见 §4 表），`ns::[expr]`/`@[expr]` 计算名与命名空间前缀处理在**阶段一百零八** 落地。仍未实现：
> ① **命名空间建模**（限定词透明 ⇒ 同局部名不同 uri 无法区分，`Namespace` 值只是占位）；② `..*` **不计文本节点**（AIR 计，`5.desc-any` 我们 2 / AIR 4）；③ **一般过滤谓词** `.(<expr>)`（只支持 `.(@attr ==/!= value)` 形态）；④ `+`/`+=` 的 XML 拼接。
> 均已在 `TODO.md` 遗留表登记。

---

## 4b. 计算名与命名空间（阶段一百零八，`adl 51.4.1` 值日志 `temp/nsbracket/`）

`x.ns::[expr]`（孩子轴，给 `XMLList`）与 `x.@[expr]`（属性轴，给 `String`）是 **DAE/COLLADA 解析的惯用法**（away3d `DAEParser.as:982` / `:1046`）。实测口径：

| 形态 | `adl` | 说明 |
|---|---|---|
| `x.ns::[name]` | 匹配**命名空间相符**的孩子 | 无前缀的孩子 + 外来 ns 得 **0**；`ns::["nope"]` 得 0 |
| `x[name]`（无限定） | **0**（对带前缀的节点） | 与 `ns::[name]` **不是**同一件事 |
| `@[expr]` | **等价于** `@字面量` | `@[at]`/`@["kind"]` 有值，`@["nope"]` 是 `""`，`@id == @["id"]` 为 true |

**本子集的近似**：`ns` 限定词与节点前缀都是「编译期透明」——孩子轴比的是**局部名**（`as_xml_local()` 取最后一个 `:` 之后），故 `x.ns::["item"]` 在 `<n:item>` 上得 **2（= AIR）**，但 `x.item`（无限定）**也给 2**（AIR 为 0）。`toString()` 仍逐字回写 `<n:item>`（存储带前缀），`localName()` 报 `item`（与 AIR 一致）。写探针时只能用 `xml.namespace()` 取命名空间对象（`new Namespace(prefix, uri)` 未实现）。

---

## 6. 难点与风险

| 难点 | 说明 | 缓解 |
|---|---|---|
| E4X 过滤谓词 `.(pred)` | 运行时谓词求值需在 C 层表达「对每个子节点查属性并比较」 | 谓词形态有限（实测只有 `@attr == "str"` 一种），编译期把谓词降级为「属性名 + 期望值」对，运行时线性比较 |
| `XML`/`XMLList` 与 `Object` 的动态索引 `obj[key]` 混淆 | `asset[node.@name]`（`assets/AssetManager.as:268`）是 `Object` 动态索引，与 XML 无关 | 已由 `as_dyn_get` 处理，XML 路径独立 |
| box tag 新增的 GC 扫描 | 新 tag 需补 `gc_mark_value` 分支，否则 DOM 树悬空回收 | 按 AGENTS.md §2.4 红线清单逐项补 |
| 极小解析器的健壮性 | 手写解析器遇非法 XML 需报错而非静默吞错 | 非法输入抛 `Error`（符合 §2.5 禁止静默吞错） |
