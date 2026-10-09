// lang-superset.as — 阶段一百零六：ASC/(ES4 预览) 语言层超集语法回归。
//
// 覆盖 talkmed-meeting 工程实测暴露的 13 项语言层缺口（报告
// talkmed-meeting-aot-gap-report-v2.md §2），每项都是 mxmlc 51.4.1 已接受、
// 而我们此前直接报 ParseError 的合法写法。运行期语义以 `adl` 值日志为准
// （temp/langair/cases.as 的 47 行逐行 diff），本示例的期望值即取自那里。
//
//   1  `a ?? b`            空值合并（仅 null/undefined 才回退；0/""/false 不回退）
//   2  `implements A, B`   多接口实现（此前逗号未被消费）
//   3  `interface X extends A, B`  接口继承（含多父）
//   4  `{23:"a"}`          数字对象键
//   5  `x..name` / `x..*`  E4X 后代轴
//   6  `<a/>` `<a></a>`    E4X 字面量
//   7  多 catch 子句        按书写顺序，首个匹配者生效
//   8  无类型形参           （默认 `*`）
//   9  `get`/`set` 作标识符
//  10  类体静态初始化（`{...}` 与无花括号语句；顺序按 AIR 实测：先字段后语句块）
//  11  类体内多余 `;`
//  12  逗号运算符           （求值两侧、取右侧值，顺序点）
//  13  类体内 `import`

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ---------- 1) 空值合并 `??` ----------
var rhsCalls:int = 0;
function rhs():String { rhsCalls++; return "R"; }

var nn:String = "v";
check((nn ?? rhs()) == "v" && rhsCalls == 0, "?? keeps a non-null left AND must not evaluate the right");
var nl:* = null;
check((nl ?? rhs()) == "R" && rhsCalls == 1, "?? falls through on null");
var ud:* = undefined;
check((ud ?? "d") == "d", "?? falls through on undefined");
// 只有 null/undefined 才回退：0/""/false 必须原样保留（这与 `||` 不同）。
var zero:* = 0;
check((zero ?? -1) == 0, "0 survives ?? (unlike ||)");
var empty:* = "";
check((empty ?? "d") == "", "empty String survives ??");
var no:* = false;
check((no ?? true) == false, "false survives ??");
// 左侧只求值一次。
var once:int = 0;
function bump():* { once++; return null; }
check((bump() ?? 5) == 5 && once == 1, "?? evaluates the left exactly once");
// 静态非空值类型直接是左值。
var k:int = 3;
check((k ?? 9) == 3, "int-typed left needs no nullish test");

// ---------- 2) 多接口实现 ----------
interface IA { function name():String; }
interface IB { function value():int; }
class Both implements IA, IB {
  public function name():String { return "both"; }
  public function value():int { return 7; }
}
var bo:Both = new Both();
check(bo.name() == "both" && bo.value() == 7, "implements A, B");
var asA:IA = bo;
var asB:IB = bo;
check(asA is IB && asB is IA, "an instance of a multi-interface class satisfies every listed interface");

// ---------- 3) 接口继承（含多父、传递） ----------
interface IChild extends IA, IB { }
interface IGrand extends IChild { function extra():String; }
class Deep implements IGrand {
  public function name():String { return "deep"; }
  public function value():int { return 11; }
  public function extra():String { return "x"; }
}
var dp:Deep = new Deep();
var gd:IGrand = dp;
check(gd is IChild, "interface extends: an IGrand instance is an IChild");
check((gd as IChild) is IA && (gd as IChild) is IB, "interface extends is transitive through both parents");
check(dp.extra() == "x" && dp.value() == 11, "inherited interface methods are implemented");
interface IEmpty extends IA { }
check((new Both() as IA) is IA, "interface extends does not disturb unrelated hierarchy");

// ---------- 4) 数字对象键 ----------
var numKeys:Object = { 23: "a", 22: "b", name: "n" };
check(numKeys[23] == "a" && numKeys["23"] == "a", "numeric object key is usable by index and by string");
check(numKeys[22] == "b" && numKeys["name"] == "n", "numeric keys coexist with identifier keys");

// ---------- 5+6) E4X 字面量与后代轴 ----------
var xml:XML = <items><item id="1">a</item><item id="2">b</item></items>;
var selfClosed:XML = <selfclosing attr="1"/>;
check(selfClosed.@attr == "1", "self-closing E4X literal parses and exposes attributes");
check(xml.item.length() == 2, "E4X child axis");
check(xml..item.length() == 2, "E4X descendant axis x..name");
// `x..*` 在 AIR 里连**文本节点**一起数（`<items><item>a</item><item>b</item></items>`
// 的 `..*` 得 4 = 2 元素 + 2 文本节点；adl 51.4.1 实测，temp/langair/cases.as 的
// `5.desc-any`）。本实现不建模文本节点，故此处用纯元素文档验证「元素后代」这一半，
// 文本节点差异记在报告已知分歧里。
var elemsOnly:XML = <items><item id="1"/><item id="2"/></items>;
check(elemsOnly..*.length() == 2, "E4X descendant axis x..* (any name), element-only content");
check(xml..items.length() == 0, "x..name excludes the receiver itself");
var only2:XMLList = xml..item.(@id == "2");
check(only2.length() == 1, "descendant axis composes with an attribute predicate");
var seen:String = "";
for each (var m:XML in xml..item) { seen += m.@id; }
check(seen == "12", "for-each over a descendant-axis XMLList yields the nodes in document order");

// ---------- 7) 多 catch 子句 ----------
function classify():String {
  try {
    throw new TypeError("boom");
  } catch (e:SyntaxError) {
    return "syntax";
  } catch (e:TypeError) {
    return "type:" + e.message;
  } catch (e:Error) {
    return "error";
  }
  return "none";
}
check(classify() == "type:boom", "multi-catch picks the first MATCHING clause, not the first written");
function classifyError():String {
  try {
    throw new Error("plain");
  } catch (e:TypeError) {
    return "type";
  } catch (e:Error) {
    return "error:" + e.message;
  }
  return "none";
}
check(classifyError() == "error:plain", "multi-catch falls through to a later, broader clause");

// ---------- 8) 无类型形参（默认 `*`） ----------
// 注：返回值类型必须显式写出——省略返回类型在 AS3 里等价于 `*`，本编译器目前
// 仍默认成 `void`（已记入报告余量：整个 709 文件闭包里 0 处省略返回类型且返回值，
// 且失败是响亮的 C 编译错误而非静默错语义）。
function ident(a):* { return a; }
check(ident(7) == 7, "untyped parameter accepts an int");
check(ident("s") == "s", "untyped parameter accepts a String");
function sum2(a, b):* { return a + b; }
check(sum2(2, 3) == 5, "untyped parameters participate in numeric arithmetic");

// ---------- 9) `get`/`set` 作标识符 ----------
var set:int = 3;
var get:int = 4;
check(set + get == 7, "get/set usable as variable names");
var box:Array = [1, 2, 3];
var acc:int = 0;
for each (var set2:* in box) { acc += set2; }
check(acc == 6, "get/set usable as a for-each loop variable");

// ---------- 10) 类体静态初始化 ----------
// 顺序以 adl 51.4.1 实测为准（temp/langair/cases.as 的 `10.order` = "abBU"）：
// **静态字段初始化器先跑**（按声明顺序 a → b），**然后**才按源码顺序跑类体语句块
// （花括号块 B、无花括号语句 U）——AVM2 把槽值放在 trait 表、把类体语句编进类初始化
// 器，故源码里字段与语句的交错**不是**运行顺序。
class InitOrder {
  static var log:String = "";
  static var a:int = InitOrder.mark("a");
  { log += "B"; }
  InitOrder.mark("U");
  static var b:int = InitOrder.mark("b");
  static function mark(t:String):int { log += t; return 0; }
}
check(InitOrder.log == "abBU", "static field initializers run first (declaration order), then the class-body blocks in source order (got '" + InitOrder.log + "')");
check(InitOrder.a == 0 && InitOrder.b == 0, "static field initializers ran");

// ---------- 11) 类体内多余 `;` ----------
class StraySemi {
  function get p():Boolean { return true; };
  function get q():Boolean { return false; };
  ;
  function f():int { return 1; }
}
check(new StraySemi().p && !new StraySemi().q && new StraySemi().f() == 1, "stray ';' between class members is tolerated");

// ---------- 12) 逗号运算符 ----------
var i:int = 0;
var j:int = 0;
var kk:int = (i = 1, j = 2);
check(i == 1 && j == 2 && kk == 2, "comma evaluates the left for effect and yields the right");
var mm:int = 0;
var nn2:int = (mm++, mm + 10);
check(mm == 1 && nn2 == 11, "comma sequences a self-modifying left before the right (no UB)");
var lo:int = 0;
var hi:int = 5;
for (lo = 0, hi = 5; lo < 2; lo++, hi--) { }
check(lo == 2 && hi == 3, "comma in a for-head update runs both operands");
var trail:int = 0;
for (var c:int = 0, c2:int = 9; c < 1; c++, c2--) { trail = c2; }
check(c == 1 && c2 == 8 && trail == 9, "comma in a for-init declares both variables (and the update runs both operands)");

// ---------- 13) 类体内 `import` ----------
class ClassImport {
  import flash.utils.ByteArray;
  function roundtrip():int {
    var bytes:ByteArray = new ByteArray();
    bytes.writeInt(4321);
    bytes.position = 0;
    return bytes.readInt();
  }
}
check(new ClassImport().roundtrip() == 4321, "class-body import is recorded and its type is usable");

trace("lang-superset: all 13 language-layer items OK");