// e4x-toxmlstring.as -- E4X markup serialisation: `toXMLString()` and the
// PRETTY-PRINTED markup that `toString()` falls back to.
//
// `toXMLString()` used to fail LOUDLY (`CodegenError: unsupported XML/XMLList
// method 'toXMLString'`) although adl supports it, and the markup we did emit kept
// the SOURCE form where adl re-indents. Both halves are the TODO.md leftover row
// "E4X 序列化残差".
//
// Every string asserted below is the verbatim value adl 51.4.1 produced for the
// same input (temp/toxml/: mxmlc + adl, XML and XMLList shapes). Two rules decide
// the shape of the output:
//
//   * element with NO element children -> INLINE markup, no newlines:
//       <a b='1'>txt</a>  ->  <a b="1">txt</a>     (toString() -> "txt")
//       <a b='1'/>        ->  <a b="1"/>           (toString() -> "")
//       <a> </a>          ->  <a/>                 (whitespace-only text pruned)
//   * element WITH element children -> PRETTY-PRINTED, one item per line,
//     indented 2 spaces per level, closing tag back at its own level:
//       <a><b/></a>        ->  <a>\n  <b/>\n</a>
//       <a><b><c/></b></a> ->  <a>\n  <b>\n    <c/>\n  </b>\n</a>
//
// `toXMLString()` and `toString()` therefore agree everywhere EXCEPT two shapes,
// both asserted here: a CHILDLESS element (markup vs text) and a ONE-item XMLList
// (the item's markup vs the item's string value).
//
// KNOWN DEVIATION, deliberately NOT asserted (registered in TODO.md): our parser
// folds every text run of a mixed-content element into ONE trimmed blob, so
// <a>a<b/>b</a> emits "<a>\n  ab\n  <b/>\n</a>" where adl interleaves the runs
// ("<a>\n  a\n  <b/>\n  b\n</a>"). Entities are likewise echoed verbatim rather
// than decoded and re-escaped (a parser gap, not a serialiser one).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. childless elements: markup vs text ------------------------------------
var t1:XML = <a b='1'>txt</a>;
check(t1.toXMLString() == "<a b=\"1\">txt</a>", "attr + text -> markup, got '" + t1.toXMLString() + "'");
check(t1.toString() == "txt", "…while toString() gives the text, got '" + t1.toString() + "'");

var t2:XML = <a b='1'/>;
check(t2.toXMLString() == "<a b=\"1\"/>", "no content -> self-closing markup, got '" + t2.toXMLString() + "'");
check(t2.toString() == "", "…while toString() is empty, got '" + t2.toString() + "'");

var t3:XML = <a> </a>;
check(t3.toXMLString() == "<a/>", "whitespace-only text is pruned, got '" + t3.toXMLString() + "'");

var t4:XML = <a>txt</a>;
check(t4.toXMLString() == "<a>txt</a>", "bare text stays inline, got '" + t4.toXMLString() + "'");

// --- 2. attribute quotes are normalised to double quotes ----------------------
var t5:XML = <a b='1' x='2'/>;
check(t5.toXMLString() == "<a b=\"1\" x=\"2\"/>", "single-quoted attrs come back double-quoted, got '" + t5.toXMLString() + "'");

// --- 3. elements WITH element children are pretty-printed ---------------------
var n1:XML = <a><b/></a>;
check(n1.toXMLString() == "<a>\n  <b/>\n</a>", "one child -> 2-space indent, got '" + n1.toXMLString() + "'");
check(n1.toString() == n1.toXMLString(), "a nested element prints the SAME string through both readers");

var n2:XML = <a b='1'><c d='2'/></a>;
check(n2.toXMLString() == "<a b=\"1\">\n  <c d=\"2\"/>\n</a>", "attrs + nested child, got '" + n2.toXMLString() + "'");

var n3:XML = <a><b><c/></b></a>;
check(n3.toXMLString() == "<a>\n  <b>\n    <c/>\n  </b>\n</a>", "indent deepens, close tag returns to its level, got '" + n3.toXMLString() + "'");

var n4:XML = <a><b/><c/></a>;
check(n4.toXMLString() == "<a>\n  <b/>\n  <c/>\n</a>", "siblings each get their own line, got '" + n4.toXMLString() + "'");

var n5:XML = <a><b>x</b></a>;
check(n5.toXMLString() == "<a>\n  <b>x</b>\n</a>", "the child itself stays inline, got '" + n5.toXMLString() + "'");

var n6:XML = <a k="v"><b n="1"/></a>;
check(n6.toXMLString() == "<a k=\"v\">\n  <b n=\"1\"/>\n</a>", "attrs on both levels, got '" + n6.toXMLString() + "'");

// --- 4. comments and the XML declaration are dropped --------------------------
var c1:XML = new XML("<a><!-- hi --><b/></a>");
check(c1.toXMLString() == "<a>\n  <b/>\n</a>", "a comment is not part of the markup, got '" + c1.toXMLString() + "'");
var c2:XML = new XML("<?xml version='1.0'?><a><b/></a>");
check(c2.toXMLString() == "<a>\n  <b/>\n</a>", "the XML declaration is dropped, got '" + c2.toXMLString() + "'");

// --- 5. XMLList: markup, where toString() delegates a LONE item ---------------
var r0:XML = <r/>;
var l0:XMLList = r0.zzz;
check(l0.toXMLString() == "", "empty list -> empty string, got '" + l0.toXMLString() + "'");

var r1:XML = <r><i>a</i></r>;
var l1:XMLList = r1.i;
check(l1.toXMLString() == "<i>a</i>", "one item -> its MARKUP, got '" + l1.toXMLString() + "'");
check(l1.toString() == "a", "…where toString() delegates to the item's string value, got '" + l1.toString() + "'");

var r2:XML = <r><i>a</i><i>b</i></r>;
var l2:XMLList = r2.i;
check(l2.toXMLString() == "<i>a</i>\n<i>b</i>", "items joined by a newline, got '" + l2.toXMLString() + "'");
check(l2.toString() == l2.toXMLString(), "≥2 items print the same string through both readers");

var r3:XML = <r><i><k/></i><i>t</i></r>;
var l3:XMLList = r3.i;
check(l3.toXMLString() == "<i>\n  <k/>\n</i>\n<i>t</i>", "each item pretty-prints on its own, got '" + l3.toXMLString() + "'");

// --- 6. the markup round-trips (re-parsing it yields the same tree) ----------
var round:XML = new XML(n3.toXMLString());
check(round.toXMLString() == n3.toXMLString(), "nested markup re-parses to the same markup");

trace("e4x-toxmlstring: ok");
