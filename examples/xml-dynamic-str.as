// xml-dynamic-str.as -- the E4X STRING VALUE when an XML/XMLList travels through a
// dynamic slot.
//
// `var s:String = xml` is statically known and goes through as_xml_string_value in
// the emitter (pinned by examples/xml-embed.as and unit: e4x/StringValue). A value
// that travels through an Object / `*` slot, an Array element, a Dictionary value or
// a dynamic property lands in the object vtable's string conversion instead, which
// used to answer "[object XML]". The live shape: talkmed-meeting resolves its
// localized labels out of an XML document through dynamic lookups, so EVERY label on
// its login page rendered "[object XML]".
//
// Measured on adl 51.4.1 (temp/xmlstr3 + temp/apv/adl): String(xml), "" + xml,
// an array element, an array joined into a string, a dynamic property and an XML
// handed to an Object parameter all print the TEXT -- while `xml as String` stays
// null (an XML is not a String). Our side of that table is pinned here.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function stringify(o:Object):String { return "" + o; }

var x:XML = <a>你好</a>;

// --- 1. through an Object slot -------------------------------------------------
var asObj:Object = x;
check(String(asObj) == "你好", "String(Object holding XML), got '" + String(asObj) + "'");
check(("" + asObj) == "你好", "concat through an Object slot");
check(stringify(x) == "你好", "an XML handed to an Object parameter stringifies");

// --- 2. as a container element / dynamic property ------------------------------
var arr:Array = [x];
check(arr[0] == "你好", "array element holding an XML");
check(arr.toString() == "你好", "the array itself stringifies its XML element");

var bag:Object = { k: x };
check(bag.k == "你好", "a dynamic property holding an XML");

// --- 3. an XMLList takes the same path (0 items -> "", 1 item -> the item's text)
// The empty list comes from a NAMED axis with no match: the WILDCARD axis `.*`
// includes TEXT nodes (adl 51.4.1: <a>t<b/></a> has two children for `.*`), so
// x.* on <a>你好</a> is a one-item list holding the text node, not an empty list.
var emptyList:XMLList = x.nope;
var s0:String = emptyList;
check(s0 == "", "an empty XMLList stringifies to the empty string, got '" + s0 + "'");
check(x.*.length() == 1 && String(x.*) == "你好", "the wildcard axis includes the text child");
var attr:XMLList = <b n="v"/>.@n;
check(attr.toString() == "v", "an attribute list stringifies to the attribute value");

// --- 4. XML is still NOT a String (the cast stays null) ------------------------
check((asObj as String) == null, "XML as String is null");



// --- 5. a String taken from an XML is an independent VALUE ---------------------
// AS3 strings are values: a pointer into an XML node is a VIEW that dies with the
// node. The labels below are read out exactly the way talkmed-meeting reads its
// language pack (`Language[key] = languageXMLList[i]` -- an XML node coerced to a
// String and stored in a static), then the tree is dropped and a collection is
// forced. Before 阶段一百四十七 the runtime handed out the node's own text buffer
// (as_xml_trim also returned an INTERIOR pointer into the parsed source), so these
// strings dangled: '[gc-audit] DANGLING reference to SWEPT block ... held by
// cn_edoctor_utils_Language_*' and SIGSEGV in gc_sweep_step / sk_textlayout_paint.
var pack:XML = new XML('<l><label name="a">Hello</label><label name="b">World</label></l>');
var keptText:String = pack.label[0];
var keptMarkup:String = String(pack.label[1]);
var keptAttr:String = pack.label[0].@name;
pack = null;
System.gc();
var churn:Array = [];                     // reuse the freed blocks
for (var i:int = 0; i < 4000; i++) churn.push("pad" + i);
check(keptText == "Hello", "a String taken from an XML survives its collection, got '" + keptText + "'");
check(keptMarkup == "World", "a markup string survives the XML's collection, got '" + keptMarkup + "'");
check(keptAttr == "a", "an attribute string survives the XML's collection, got '" + keptAttr + "'");
check(churn.length == 4000, "churn");

trace("xml-dynamic-str: ok");
