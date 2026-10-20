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

### 2.6 字符串值与 `XML(ByteArray)`（阶段一百四十三，`adl 51.4.1` 值日志 `temp/tkmeet-mac/{xmlstr,xmlba}/`）

真应用 talkmed-meeting 的语言资源走 `XML(new language_en())`（`[Embed(..., mimeType="application/octet-stream")]`
⇒ 生成的资源类是 **ByteArray 子类**），实测把两条规则钉死：

**一、`XML(value)` 接受 ByteArray**（其字节即 UTF-8 标记文本）。调用点静态类型是 `Class`/`*` 时走**动态**分支，
故 `as_xml_from_value` 必须认 ByteArray（含一切 ByteArray 子类 —— `as_is` 沿 `super` 链走，`[Embed]` 类都命中）。

| 输入 | `adl` | 本子集 |
|---|---|---|
| `XML(ba)`（UTF-8 标记） | 解析出的树（多字节字符完好） | ✅ 同（`examples/xml-embed.as`） |
| `XML(new <octet-stream Embed 类>())` | 同上 | ✅ 同 |
| `XML(xmlNode)` | 透传 | ✅ 同 |

**二、`toString()` 是 E4X 的「字符串值」，不是标记**：

| 形状 | `toString()` | `toXMLString()` |
|---|---|---|
| 文本节点 `new XML("plaintext")` | `plaintext` | `plaintext`（✅ 阶段二百零八起，见下） |
| `<a b='1'>txt</a>`（**无**元素子节点） | `txt` | `<a b="1">txt</a>` |
| `<a b='1'/>`（无子节点） | `""` | `<a b="1"/>` |
| `<a> </a>`（纯白空格文本） | `""` | `<a/>` |
| `<a b='1'><c d='2'/></a>`（**有**元素子节点） | 标记（2 空格缩进） | 同 `toString()` |
| `<a>x<b/>y</a>` | 标记（按文档序**交错**） | 同 `toString()` |
| `XMLList`：0 / **1** / ≥2 项 | `""` / **该项的字符串值**（`"a"`） / 各项**标记**以换行连接 | `""` / **该项的标记**（`<i>a</i>`） / 同左 |

**阶段一百九十三补齐**（同一段 `adl 51.4.1` 实测，`temp/toxml/`：XML + XMLList 共 24 格逐字一致）：`toXMLString()`
接线到标记序列化器 `as_xml_to_string`（`XMLList` 走 `as_xml_list_to_xml_string`），且标记按 AIR **重新缩进** ——
**无**元素子节点 ⇒ 单行内联（`<a b="1">txt</a>`）；**有** ⇒ 每行一项、每层 2 空格、闭合标签回本层，并**剪掉纯白
空格文本节点**；属性一律**双引号**；注释与 `<?xml …?>` 声明被丢弃。端到端断言见 `examples/e4x-toxmlstring.as`，
结构钉见 `test/unit/emit.ts` 的 `unit: e4x/ToXMLString`。

**阶段二百零八：三条解析器残余已对齐**（`adl 51.4.1` 逐字实测，差分探针 `temp/e4xres/diff/`
63 条记录**逐字节一致**；端到端断言 `examples/e4x-text-mixed.as`，结构钉 `unit: e4x/TextNodes`）。
三条残余原本**全在解析器**，序列化只是被解析器的形状拖累：

**① 文本节点构造**。`new XML(...)` 的参数里**没有 `<`** 时，参数本身就是**一个文本节点**（不是报错）：

| 输入 | `nodeKind()` | `localName()`/`name()` | `toString()`/`toXMLString()` | `text()` | `length()` | `children()` |
|---|---|---|---|---|---|---|
| `"plaintext"` | `"text"` | `null` / `null` | `plaintext` | `""` | 1 | 0 |
| `"  hi there  "` | `"text"` | — | `hi there`（去两端空白） | `""` | 1 | 0 |
| `""` / `"   "` | `"text"` | — | `""` | `""` | 1 | 0 |

注意 `text()` **不是**节点的值：`text()` 选的是**文本子节点**，文本节点自己没有子节点，故为 `""`。
`name`/`localName` 为 `null`，所以命名轴（`x.foo`）永远匹配不到文本节点。而 `text<a/>` / `<a/>trail` /
`<a/><b/>` 这类「根元素之外还有标记/游离文本」仍是**文档级错误 `#1088`**（见下表）。

**② 混合内容按文档序**。DOM 不再用单个 `text` 槽折叠，而是把**每个文本 run 作为子节点**按出现顺序插入，
元素与文本**交错**：

| 形状 | 旧输出（错） | 现在 = `adl` |
|---|---|---|
| `<a>a<b/>b</a>` | `<a>\n  ab\n  <b/>\n</a>` | `<a>\n  a\n  <b/>\n  b\n</a>` |
| `<a>x<b/>y<c/>z</a>` | 折叠成 `xyz` | `<a>\n  x\n  <b/>\n  y\n  <c/>\n  z\n</a>` |
| `<a> a <b/> b </a>` | — | 每个 run **各自** trim（`a` / `b`） |
| `<a>x<!--c-->y</a>` | — | 注释**切开** run ⇒ 两个文本子节点、输出两行 |
| `<a> <b/> </a>` | — | 纯白空格 run 被**丢弃** ⇒ `<a>\n  <b/>\n</a>`，`children()` = 1 |
| `<a>&#32;</a>` | — | 解码**后**才变空 ⇒ 保留**空**文本节点，输出 `<a></a>` |

轴的口径随之确定：`children()` / `child("*")` / `.*` / **后代轴 `..*`** 都**含文本节点**
（`<a>t1<b>bt</b>t2<c/></a>` 的 `.*` = 4、`..*` = 5），`elements()` 才是**纯元素**轴（= 2）。
序列化规则也改了一处形状：**恰好一个**文本/CDATA 子节点才**内联**，其余（含 0 个）按层缩进 ——
所以 `<a>pre<![CDATA[mid]]>post</a>` 是三行，而 `<a>txt</a>` 仍是 `<a>txt</a>`。

**③ 实体：解析期解码 + 输出期按上下文转义**。旧实现不解码，于是只能原样回显（`&#65;` 永远出不来 `A`），
且不敢在输出侧加转义（会双重转义）。现在解码与转义**各归一侧**：

| 输入 | `toString()` | `toXMLString()` |
|---|---|---|
| `<a>&#65;&amp;&lt;&gt;&quot;&apos;&#x42;</a>` | `A&<>"'B` | `<a>A&amp;&lt;&gt;"'B</a>` |
| `<a>&foo;</a>`（未知命名实体） | `&foo;`（**原样**） | `<a>&amp;foo;</a>`（`&` 才转义） |
| `<a>&amp;lt;</a>` | `&lt;`（**只**解一层） | `<a>&amp;lt;</a>` |
| `<a>&#x1F600;</a>` / `<a>&#0;</a>` | 原样 | 转义后原样 |
| `<a><![CDATA[<b/> & raw]]></a>` | `<b/> & raw` | `<a><![CDATA[<b/> & raw]]></a>`（**仍以 CDATA 形态**重发，内容不解码、不 trim） |

两处 AIR 怪癖照抄：`&nbsp;` 解成 **U+FFA0**（不是 U+00A0）；数值引用只在 **≤ U+FFFF** 时解码，超出 BMP 的
（含 `&#0;`）**原样保留**。转义集**分上下文**：文本转义 `&`/`<`/`>`（引号与空白**不转**）；属性值转义
`&`/`<`/`"` 并把 TAB/LF/CR 写成 `&#x9;`/`&#xA;`/`&#xD;`（`>` 与 `'` **不转**，属性值也**不 trim**）。

错误号与文案（`TypeError`，`errorID` 可直接断言 —— 旧实现一律 `#1090`）：

| 触发 | `adl` |
|---|---|
| 元素未闭合 / 闭合标签不匹配 | `#1085: The element type "a" must be terminated by the matching end-tag "</a>".`（报**打开**的那个元素） |
| 根元素之外还有标记/游离文本 | `#1088: The markup in the document following the root element must be well-formed.` |
| 标签畸形 / 起始标签内 EOF / 属性未加引号 | `#1090: XML parser failure: element is malformed.` |

**本行剩余（不影响上述三条）**：元素名不做转义；CDATA 内容含 `]]>` 时未拆分；`attributes()` 仍只回第一个
属性的值（`unit: e4x/ListAttrScalar` 记录的口径）。

### 2.7 动态槽里的 XML/XMLList 也必须是字符串值（阶段一百四十四，实测 `temp/xmlstr3` + `temp/apv/adl`）

上一节的规则覆盖**静态已知**的 `var s:String = xml`（发射侧直接走 `as_xml_string_value`）。但值一旦流经
**动态槽** —— `Object`、`*`、数组元素、`Dictionary` 值、动态属性、`Object` 形参 —— 就落到**对象 vtable 的字符串
转换槽**（`box_to_str`），于是输出 `[object XML]`。

真应用形态：talkmed-meeting 的本地化文案存在 XML 里、经**动态查表**取出，登录页**每一条文案**都渲染成
`[object XML]`（窗口标题也是）。

| 形状 | `adl` | 修复前 | 现在 |
|---|---|---|---|
| `String(o)`，`o:Object` 持有 XML | 文本 | `[object XML]` | ✅ 文本 |
| `"" + o` / 形参传 XML | 文本 | `[object XML]` | ✅ 文本 |
| `[x]` 的 `[0]`、数组整体 `toString()` | 文本 | `[object XML]` | ✅ 文本 |
| `{k:x}.k` 动态属性 | 文本 | `[object XML]` | ✅ 文本 |
| `XMLList` 经动态槽（0 项 / 1 项） | `""` / 该项字符串值 | `[object XMLList]` | ✅ 同 |
| `xml as String` | `null`（XML 不是 String） | `null` | ✅ 不变 |

**实现**：`as_xml_vt`/`as_xml_list_vt` 的 `box_to_str` 从 `as_object_box_to_str` 换成
`as_xml_box_to_str`/`as_xml_list_box_to_str`（委托给 `as_xml_string_value`/`as_xml_list_to_string`）。
例：`examples/xml-dynamic-str.as`；结构钉：`unit: e4x/StringValue` 后三条。

例：`examples/xml-dynamic-str.as`；结构钉：`unit: e4x/StringValue` 后三条。

### 2.8 `describeType` 的 XML 形状（阶段一百八十六，实测 `temp/dtor` + `temp/t1`）

`describeType` 的产物是 应用侧模型映射器（`BaseModel.fromJSON`）的**唯一输入**：它遍历
`describeType(this)..variable` / `..accessor`，按 `@name`/`@type` 把 JSON 字段赋到模型上。此前的实现只发一个
**无子节点**的 `<type name="包::类"/>`，于是 `..variable` 恒为空、所有字段停在 AS3 默认值、嵌套模型保持
`null`，下一次读取就抛未捕获的 `#1009`（真应用「点击某会议即卡死」的根因）。阶段一百八十六按
`adl 51.4.1` 逐项对齐：

| 语义 | 实测口径 |
|---|---|
| `@name` / `@type` | 用 **`::`**（`pkg::PackThing`、`flash.display::Sprite`、`__AS3__.vec::Vector.<int>`），不是点号 |
| 实例视图 | `base="<直接父类>"`、`isStatic="false"`，成员直接内联；**`Object` 实例无 `base`、无 `<extendsClass>`** |
| 类视图 | `base="Class"`、`isStatic="true"`，`<extendsClass type="Class"/>` + `<extendsClass type="Object"/>` + `<accessor name="prototype" access="readonly" type="*" declaredBy="Class"/>`，成员挂在 `<factory type="类名">` 下 |
| 继承链 | `<extendsClass>`/`<implementsInterface>` 列**完整链**（最近的在前，含 `Object`） |
| 成员可见性 | **只列 public** |
| `variable` / `constant` | **无** `declaredBy`；不存在的属性读出来是**空串**（AIR 同） |
| `accessor` / `method` | **有** `declaredBy`；`accessor` 带 `access="readonly\|writeonly\|readwrite"` |
| `method` | 带 `returnType` 与每个参数的 `<parameter index/type/optional>`；**rest 参数不列** |
| `<constructor>` | 仅当构造器**有参数**时出现（签名走 `as_dt_ctors[]` 侧表 —— 只有带参构造器、自身又无方法的类，方法表里没有它的位置） |
| 接口名 | 走 `as_dt_iface_names[]` 侧表（接口 vtable 只有 5 字段前缀，没有 `fqn` 槽位） |
| `Object` 自身成员 | **从不列**（子类与普通对象都一样）⇒ `describeType({})` 就是一个裸的 `<type name="Object" isDynamic="true" isFinal="false" isStatic="false"/>` |
| 基元 / 容器 | `int`/`Number`/`String`/`Boolean` → `isDynamic=false`、`isFinal=true`（`String` 另有只读 `length`）；`Array` → dyn=true/fin=false + 可读写 `length`(uint)；`Vector.<int>` → dyn=true/**fin=true**；`flash.utils::Dictionary` → dyn=true；`Date` 无包名 |
| `describeType(null)` | **空串**；`describeType(undefined)` 抛 `#1010` |
| 成员顺序 | AIR 是**不可复现的哈希序**，我们按声明序 —— 这是**刻意**的差异（`adl` 自己的顺序每次运行都可能不同） |

**实现取径**：不新造「每类一个 describeType 大 blob」，而是**扩充已有反射表**（`as_prop` 增
`is_accessor`/`is_const`、`as_method` 增 `sig`、vtable 头增 `is_dynamic`/`is_final`），XML 在运行时由这些表拼装。
体积小，且 `describeType` 从未被调用时 `-O2` 能把整块（`static` 函数）剪掉。

**两个必须记住的安全口径**：

1. **判定「是不是类实例」只能是「把候选对象的第一个字拿去和 `as_class_registry[i].cls->vtable` 比」** ——
   `Array`/`Dictionary`/`Vector`/`XML` 的 GC 体第一个字是**数据/名字指针**，一旦当 vtable 解引用就崩。比较**不解引用**，
   再配合 `as_dyn_kind(v.ptr) != 0` 前置闸门，错认与崩溃一起消掉。
2. **`as_prop_read` 的 tag 10（声明类型是 `Array` 的字段）必须 box 成 `as_v_arr`（tag 6）**，不能 box 成对象 ——
   否则数组的**数据指针**会被当成 vtable 暴露给所有反射消费者（`String(x)`、`is Array`、动态访问）。

例：`examples/describe-type.as`；结构钉：`unit: reflect/DescribeType`、`unit: reflect/PropBoxing`。

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
| `emit.ts` | ✅ `describeType` 真实现（阶段一百八十六 按 `adl 51.4.1` 完整对齐，见 §2.8）：反射表随类发射（`as_prop` 带 `is_accessor`/`is_const`、`as_method` 带 `sig`、vtable 带 `is_dynamic`/`is_final`），XML 树由 `as_dt_shape`/`as_dt_traits` 运行时拼装（`<type>`/`<extendsClass>`/`<implementsInterface>`/`<variable>`/`<constant>`/`<accessor>`/`<method>`/`<parameter>`/`<factory>`）；✅ 计算名按接收者分派（xml/xmllist → `as_xml_*`，Proxy/动态对象属性轴 → `as_dyn_get`，其余接收者**响亮** `CodegenError`） |
| `runtime.ts` | ✅ 内嵌 `as_xml_parse` 极小 DOM 解析器 + `as_xml_attr`/`as_xml_children`/`as_xml_filter`/`as_xml_descendants`/`as_xml_list_*` 全套助手；**孩子轴按「本地名」比对**（`as_xml_local()`，阶段一百零八）；✅ `describeType` 拼装器（`as_dt_class_of`/`as_dt_shape`/`as_dt_traits`，阶段一百八十六，见 §2.8），**候选对象只与注册表里的 vtable 比较、从不解引用** |

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
| 一百八十六 | `describeType` 的 XML 形状**按 `adl` 完整对齐**（此前只发一个无子节点的 `<type name="包::类"/>` ⇒ 模型映射器全空 ⇒ 未捕获 `#1009`） | v0.4.166 → v0.4.167 | `describe-type.as` |

> **修正（阶段一百零八）**：上面这行旧结论**已过时** —— XML 字面量与 `..` 后代轴在**阶段一百零六** 落地（见 §4 表），`ns::[expr]`/`@[expr]` 计算名与命名空间前缀处理在**阶段一百零八** 落地。仍未实现：
> ① **命名空间建模**（限定词透明 ⇒ 同局部名不同 uri 无法区分，`Namespace` 值只是占位）；② `..*` **不计文本节点**（AIR 计，`5.desc-any` 我们 2 / AIR 4）；③ **一般过滤谓词** `.(<expr>)`（只支持 `.(@attr ==/!= value)` 形态）；④ `+`/`+=` 的 XML 拼接。
> 均已在 `TODO.md` 遗留表登记。
> ⑤ **`toXMLString()` 未实现**（响亮 `CodegenError`）；⑥ 标记输出**不按 AIR 重新缩进**、**不剪纯白空格文本节点**（阶段一百四十三 实测，见 §2.6）。

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
