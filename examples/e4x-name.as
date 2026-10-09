// e4x-name.as — 阶段一百零八：E4X **计算名**（子轴 `x.ns::[expr]` 与属性轴 `x.@[expr]`）。
//
// 这是 AOT 编译 away3d-core（479 .as 的 adl 参照基线，见 examples/away3d-core）
// 时暴露的语言层缺口之一，此前一律 ParseError。语法与语义以 mxmlc/adl 51.4.1
// 实测为准，证据 temp/nsbracket/（AdlScene.as 的 20 行值日志），本示例的期望值
// 即取自那里。
//
// 关键实测结论（决定了本示例的树为什么带命名空间）：
//   * `x.ns::[expr]` 要求**命名空间也匹配**，不只是局部名。同一棵树里
//     `<n:item>`（ns=urn:x）能被 `ns::[`"item"`]` 命中，无命名空间的 `<item>`
//     则**不能**（探针 A1 从 0 变 2 就是这个开关）。
//   * 命名空间本身我们不建模（`::` 一律透明，见 parser.ts 的 `::` 注释），
//     所以「同局部名、异命名空间」时我们会多命中——该近似已登记 TODO.md。
//
// 两处语法：
//   A  `x.ns::[expr]`  子轴计算名：与 `x.名字` 同一个轴，名字在运行期求值
//   B  `x.@[expr]`     属性轴计算名：与 `x.@名字` 逐字等价

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ---------- A) 子轴计算名 ----------
// 子件带命名空间 + 一个 Namespace 对象：两端语义一致的那种情形（命名空间必须
// 匹配才命中，所以这里用匹配的 `urn:x`）。
var xml:XML =
  <items xmlns:n="urn:x">
    <n:item id="1">a</n:item>
    <n:item id="2">b</n:item>
    <n:other id="3">c</n:other>
  </items>;
// DAEParser 的原句式：命名空间对象取自 E4X 节点自身。在本子集里 Namespace 值
// 是透明占位（`::` 限定词一律丢弃），这里只是为了写出真实的 `x.ns::[expr]` 形态。
var ns:Namespace = xml.namespace();
var child:String = "item";

check(xml.ns::[child].length() == 2, "x.ns::[expr] walks the child axis for the computed local name");
check(xml.ns::[child].toString() == xml.ns::item.toString(),
  "x.ns::[expr] is the same child axis as the identifier form x.ns::item");
check(xml.ns::["other"].length() == 1, "the computed name may be written as a literal");
check(xml.ns::["nope"].length() == 0, "an unmatched computed name yields an empty list, not a throw");

var seen:String = "";
for each (var c:XML in xml.ns::[child]) seen += c.@id;
check(seen == "12", "for-each over the computed-name list keeps document order");

// 一个 XMLList 接收者上同样成立：`deep.ns::[g]` 得列表，再按计算名取子件。
var deep:XML =
  <root xmlns:n="urn:x">
    <n:group>
      <n:leaf id="1"/>
      <n:leaf id="2"/>
    </n:group>
  </root>;
var g:String = "group";
check(deep.ns::[g].ns::["leaf"].length() == 2,
  "an XMLList receiver flattens its children by the computed name (.a then ns::[expr])");

// ---------- B) 属性轴计算名 ----------
var one:XML = <item id="7" kind="t"/>;
var at:String = "id";

check(one.@[at] == "7", "x.@[expr] reads the attribute whose name is computed at run time");
check(one.@["kind"] == "t", "the computed name may be written as a literal");
check(one.@["nope"] == "", "an absent attribute yields the empty string (no throw)");
check(one.@id == one.@["id"] && one.@id == "7", "the identifier form x.@name is unchanged");

trace("e4x-name: computed E4X names (child + attribute axes) OK");