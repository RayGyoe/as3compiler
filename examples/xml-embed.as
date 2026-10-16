// xml-embed.as -- `XML(byteArray)`: parsing a ByteArray as E4X markup.
//
// AIR accepts ANY ByteArray in `XML(value)` and treats its BYTES as the markup
// (UTF-8). The live shape is the asset-embedding idiom:
//
//     [Embed(source="...", mimeType="application/octet-stream")]
//     private static var language_en:Class;
//     ...
//     var languageXml:XML = XML(new language_en());   // the arg is a ByteArray!
//
// `mimeType="application/octet-stream"` makes the generated asset class a
// flash.utils.ByteArray subclass, and because the static type at the call site is
// `Class`/`*`, the reference compiler reaches the DYNAMIC XML-conversion branch --
// which previously failed loudly with "XML(value) is only supported for String and
// XML values by this subset". This example pins the fix.
//
// Measured on adl 51.4.1 (temp/tkmeet-mac/xmlba): XML(ba) over UTF-8 markup yields
// the parsed tree with multi-byte characters intact, and XML(new <embedded class>())
// behaves identically; XML(XML) passes the node through unchanged.

import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Assets {
  [Embed(source="embed-assets/lang.xml", mimeType="application/octet-stream")]
  public static const lang:Class;
}

// --- 1. the embedded-asset idiom: XML(new <ByteArray subclass>()) --------------
// The argument's static type is `Class`, so this takes the dynamic branch.
var langXml:XML = XML(new Assets.lang());
check(langXml.localName() == "root", "XML(embed ByteArray) parses; root is " + langXml.localName());

var labels:XMLList = langXml.child("label");
check(labels.length() == 2, "two <label> children, got " + labels.length());
check(labels[0].attribute("name") == "hello", "first label name");
check(labels[0].toString() == "世界 HELLO", "UTF-8 text decoded, got '" + labels[0].toString() + "'");
check(labels[1].attribute("name") == "bye", "second label name");
check(labels[1].toString() == "再见", "second label UTF-8 text");

// --- 2. a plain ByteArray behind a `*` reaches the same dynamic branch ---------
var raw:ByteArray = new ByteArray();
raw.writeUTFBytes("<r a='1'>中文</r>");
var asStar:* = raw;
var y:XML = XML(asStar);
check(y.localName() == "r", "flat ByteArray parses, localName=" + y.localName());
check(y.attribute("a") == "1", "attribute survives");
check(y.toString() == "中文", "multi-byte text survives, got '" + y.toString() + "'");

// --- 3. XML(XML) is a pass-through (unchanged behaviour, re-pinned) ------------
var again:XML = XML(langXml);
check(again.child("label").length() == 2, "XML(XML) keeps the tree");

trace("xml-embed: ok");
