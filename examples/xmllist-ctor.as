// `new XMLList(...)`: the E4X list constructor, which previously failed with
// "unknown class 'XMLList'". Semantics measured on adl 51.4.1
// (temp/qfix/xmllist.body.as): null/undefined -> an empty list; an XML node ->
// a one-item list; an XMLList -> a copy; any other value -> a one-item list
// holding a text node of the value's string form.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function run():void {
  var empty:XMLList = new XMLList();
  check(empty.length() == 0, "new XMLList() is empty");

  var empty2:XMLList = new XMLList(null);
  check(empty2.length() == 0, "new XMLList(null) is empty");

  var text:XMLList = new XMLList("hi");
  check(text.length() == 1, "new XMLList(String) has one item");
  check(text.toString() == "hi", "new XMLList(String) holds the text");

  var num:XMLList = new XMLList(5);
  check(num.length() == 1, "new XMLList(Number) has one item");
  check(num.toString() == "5", "new XMLList(Number) stringifies the value");

  var x:XML = <r><a>1</a><a>2</a></r>;
  var one:XMLList = new XMLList(x);
  check(one.length() == 1, "new XMLList(XML) has one item");

  var copy:XMLList = new XMLList(x.a);
  check(copy.length() == 2, "new XMLList(XMLList) copies the items");
  check(copy.toString().indexOf("1") >= 0, "copy carries the content");

  trace("xmllist-ctor: all checks passed");
}

run();
