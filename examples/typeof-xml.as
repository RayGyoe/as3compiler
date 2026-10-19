// typeof-xml.as -- E4X values have their own typeof bucket in AIR: "xml".
//
// Both XML and XMLList report "xml" (never "object"), and in EVERY slot shape:
// a statically xml-typed operand, a `*` slot, and an Object slot. The same value
// is a perfectly ordinary object for `is Object` / `<obj>` dynamic access, so a
// naive "it is an object pointer, therefore typeof is object" shortcut is wrong
// for exactly these two types.
//
// Reference values are the adl 51.4.1 oracle on this same source
// (temp/d31probe/adl-typeof.txt); ours is byte-identical after the fix. Before
// it, the static path folded every xml-typed operand to "object", and a boxed
// XML value fell through the vtable chain in as_ptr_typeof / as_v_typeof to
// "object" as well -- which is what app code that switches on typeof saw.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var x:XML = <a/>;
var xl:XMLList = XMLList(x);
var arr:XMLList = <r><c/><c/></r>.c;   // a 2-element list from an E4X query

// --- 1. every slot shape reports "xml" --------------------------------------
check(typeof x == "xml", "a statically XML-typed operand, got " + typeof x);
check(typeof xl == "xml", "a statically XMLList-typed operand, got " + typeof xl);
check(typeof arr == "xml", "an XMLList of two nodes, got " + typeof arr);

var anySlot:* = x;
check(typeof anySlot == "xml", "a `*` slot holding an XML, got " + typeof anySlot);
var listSlot:* = xl;
check(typeof listSlot == "xml", "a `*` slot holding an XMLList, got " + typeof listSlot);

var objSlot:Object = x;
check(typeof objSlot == "xml", "an Object slot holding an XML, got " + typeof objSlot);

// A parameter, so neither the AOT compiler nor clang can fold the answer.
function kindOf(v:*):String { return typeof v; }
check(kindOf(x) == "xml", "typeof through a `*` parameter, got " + kindOf(x));
check(kindOf(xl) == "xml", "typeof of an XMLList through a `*` parameter, got " + kindOf(xl));

// --- 2. the other buckets are untouched -------------------------------------
check(typeof 5 == "number", "Number");
check(typeof "s" == "string", "String");
check(typeof true == "boolean", "Boolean");
check(typeof null == "object", "null is \"object\" (not \"null\")");
check(typeof undefined == "undefined", "undefined");
check(typeof {} == "object", "a plain object literal");
check(typeof [] == "object", "an Array is \"object\"");
check(typeof new Date() == "object", "a Date is \"object\"");
var fn:Function = function():void { };
check(typeof fn == "function", "a function value");

// --- 3. an XML is still an object for everything else -----------------------
check(x is Object, "an XML is an Object");
check(x is XML, "an XML is an XML");
// String() of an XML is its TEXT CONTENT, not the markup (measured on adl 51.4.1,
// temp/d31probe/adl-xstr.txt: String(<a/>) is "" and String(<r a="1">t</r>) is
// "t"; the markup form is toXMLString(), which e4x-toxmlstring.as covers).
check(String(x) == "", "String(a childless element) is empty, got '" + String(x) + "'");
check(String(<r a="1">t</r>) == "t", "String of an element is its text content");
check(x.children().length() == 0, "a childless element has an empty children list");

trace("typeof-xml: E4X values report \"xml\" OK");
