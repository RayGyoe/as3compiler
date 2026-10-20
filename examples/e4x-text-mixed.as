// e4x-text-mixed.as -- the three E4X parser residuals of TODO.md's leftover row
// "E4X 序列化残差", all measured against adl 51.4.1 (temp/e4xres/):
//
//   ① TEXT NODE CONSTRUCTION. new XML("plaintext") is a TEXT node, not an error:
//      nodeKind "text", localName/name null, toString() and toXMLString() both
//      the value, text() EMPTY (text() selects the text CHILDREN, and a text
//      node has none).
//   ② MIXED CONTENT. Text runs and elements keep DOCUMENT ORDER, so
//      <a>a<b/>b</a> serialises as three lines (a, b, b) instead of folding both
//      runs into one "ab" blob. The wildcard child axis (children(), child("*"),
//      `.*`) counts text nodes; elements() does not.
//   ③ ENTITIES. They are DECODED on the way in (named + numeric) and the
//      serialiser ESCAPES on the way out -- per-context, and with the two
//      different sets adl uses for text and for attribute values.
//
// Everything asserted here is a verbatim adl 51.4.1 value; the differential probe
// that produced it lives in temp/e4xres/diff/ (63 records, byte-identical).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function expectError(src:String, id:int, label:String):void {
  var got:int = 0;
  try { new XML(src); } catch (e:Error) { got = e.errorID; }
  check(got == id, label + ": expected error #" + id + ", got #" + got + " for " + src);
}

// ---------- ① a text node ----------
var t:XML = new XML("plaintext");
check(t.toString() == "plaintext", "text node toString, got '" + t.toString() + "'");
check(t.toXMLString() == "plaintext", "text node toXMLString, got '" + t.toXMLString() + "'");
check(t.nodeKind() == "text", "text node nodeKind, got '" + t.nodeKind() + "'");
check(t.localName() == null, "a text node has no localName");
check(t.name() == null, "a text node has no name");
check(t.length() == 1, "XML.length() is 1 for a text node");
check(t.text().toString() == "", "text() of a text node is empty (it selects CHILDREN)");
check(t.children().length() == 0, "a text node has no children");

check(new XML("  pad me  ").toString() == "pad me", "edges are trimmed");
check(new XML("42").toXMLString() == "42", "digits stay text, not markup");
check(new XML("   ").toString() == "", "whitespace-only input is an empty text node");
check(new XML("").toString() == "", "empty input is an empty text node");
check(new XML("  &amp;  ").toString() == "&", "entities decode in a text node too");
check(new XML("a & b").toString() == "a & b", "a bare ampersand is literal text");

// Markup around the root is still an error, with the reference runtime's id and
// wording: free text makes the document ill-formed.
expectError("text<a/>", 1088, "free text before the root element");
expectError("<a/>trail", 1088, "free text after the root element");
expectError("<a/><b/>", 1088, "a second root element");
expectError("<a>", 1085, "unterminated element");
expectError("<a></b>", 1085, "mismatched close tag");
expectError("<a b=1/>", 1090, "malformed attribute");

// ---------- ② mixed content ----------
var m:XML = new XML("<a>a<b/>b</a>");
check(m.toXMLString() == "<a>\n  a\n  <b/>\n  b\n</a>", "text and elements INTERLEAVE, got '" + m.toXMLString() + "'");
check(m.toString() == m.toXMLString(), "toString() is the same markup here");
check(m.text().toString() == "ab", "text() concatenates every direct text run");
check(m.children().length() == 3, "the wildcard axis counts text nodes");
check(m.elements().length() == 1, "elements() is the element axis only");

var m2:XML = new XML("<a>x<b/>y<c/>z</a>");
check(m2.toXMLString() == "<a>\n  x\n  <b/>\n  y\n  <c/>\n  z\n</a>", "two interleaved runs, got '" + m2.toXMLString() + "'");

var m3:XML = new XML("<a> a <b/> b </a>");
check(m3.toXMLString() == "<a>\n  a\n  <b/>\n  b\n</a>", "each run is trimmed on its own, got '" + m3.toXMLString() + "'");

var m4:XML = new XML("<a>t1<b><c/>t2</b>t3</a>");
check(m4.toXMLString() == "<a>\n  t1\n  <b>\n    <c/>\n    t2\n  </b>\n  t3\n</a>", "nesting keeps the interleave, got '" + m4.toXMLString() + "'");

var m5:XML = new XML("<a>x<!--mid-->y</a>");
check(m5.toXMLString() == "<a>\n  x\n  y\n</a>", "a comment SPLITS a text run in two, got '" + m5.toXMLString() + "'");
check(m5.children().length() == 2, "…so there are two text children");

var m6:XML = new XML("<a> <b/> </a>");
check(m6.toXMLString() == "<a>\n  <b/>\n</a>", "whitespace-only runs are pruned, got '" + m6.toXMLString() + "'");
check(m6.children().length() == 1, "…and contribute no child");

check(new XML("<a>t1<b>bt</b>t2<c/></a>").children()[0].nodeKind() == "text", "children()[0] can BE a text node");
check(new XML("<a>t1<b>bt</b></a>").children()[0].toString() == "t1", "…whose string value is its own text");

// ---------- ③ entities: decode on input, escape on output ----------
var e1:XML = new XML("<a>&#65;&amp;&lt;&gt;&quot;&apos;&#x42;</a>");
check(e1.toString() == "A&<>\"'B", "named + numeric references decode, got '" + e1.toString() + "'");
check(e1.toXMLString() == "<a>A&amp;&lt;&gt;\"'B</a>", "…and text re-escapes only & < >");

check(new XML("<a b='&amp;&#65;'/>").toXMLString() == "<a b=\"&amp;A\"/>", "attribute values decode too");
check(new XML("<a b='say &quot;hi&quot;'/>").toXMLString() == "<a b=\"say &quot;hi&quot;\"/>", "an attribute quote is escaped");
check(new XML("<a b='x&#10;y'/>").toXMLString() == "<a b=\"x&#xA;y\"/>", "an attribute newline becomes a reference");
check(new XML("<a b='x&#9;y'/>").toXMLString() == "<a b=\"x&#x9;y\"/>", "…and so does an attribute tab");
check(new XML("<a b='x>y'/>").toXMLString() == "<a b=\"x>y\"/>", "an attribute '>' stays raw");

check(new XML("<a>&#25991;&#23383;</a>").toString() == "\u6587\u5b57", "numeric references build UTF-8 text");
check(new XML("<a>&foo;</a>").toString() == "&foo;", "an UNKNOWN entity stays verbatim");
check(new XML("<a>&foo;</a>").toXMLString() == "<a>&amp;foo;</a>", "…and its ampersand is escaped on the way out");
check(new XML("<a>&amp;lt;</a>").toString() == "&lt;", "decoding happens ONCE");
check(new XML("<a>&amp;lt;</a>").toXMLString() == "<a>&amp;lt;</a>", "…so the round trip is stable");
check(new XML("<a>&#x1F600;</a>").toXMLString() == "<a>&amp;#x1F600;</a>", "a code point above the BMP stays verbatim");
check(new XML("<a>&#32;</a>").toXMLString() == "<a></a>", "an entity-decoded whitespace run keeps an EMPTY text node");

// ---------- CDATA is text, but keeps its markup form ----------
var c1:XML = new XML("<a><![CDATA[<b/> & raw]]></a>");
check(c1.toXMLString() == "<a><![CDATA[<b/> & raw]]></a>", "CDATA content is literal, got '" + c1.toXMLString() + "'");
check(c1.text().toString() == "<b/> & raw", "…and is the element's text");
check(c1.children()[0].nodeKind() == "text", "nodeKind() reports a CDATA section as text");
check(new XML("<a><![CDATA[  x  ]]></a>").toXMLString() == "<a><![CDATA[  x  ]]></a>", "CDATA whitespace is NOT trimmed");
check(new XML("<a>pre<![CDATA[mid]]>post</a>").toXMLString() == "<a>\n  pre\n  <![CDATA[mid]]>\n  post\n</a>", "a CDATA section interleaves like any text run");
check(new XML("<a>pre<![CDATA[mid]]>post</a>").toString() == "premidpost", "…and joins the string value");
check(new XML("<![CDATA[x]]>").toXMLString() == "<![CDATA[x]]>", "a root CDATA section is a node of its own");

trace("e4x-text-mixed: all checks passed");