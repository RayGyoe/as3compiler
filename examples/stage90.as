// stage90.as — E4X XML/XMLList 类型建模 + 极小解析器（阶段九十）。
//
// 覆盖：XML 类型、new XML(str) / XML(str) 运行时构造、localName()、toString()。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. new XML(str) 构造 + localName ---
var xml:XML = new XML("<a b='1'><c d='2'/></a>");
check(xml.localName() == "a", "localName of root element");

// --- 2. XML(str) 函数式调用 ---
var xml2:XML = XML("<root/>");
check(xml2.localName() == "root", "XML(str) function call");

// --- 3. 嵌套元素 + 自闭合 ---
var xml3:XML = new XML("<font><info face='Arial'/><chars count='3'/></font>");
check(xml3.localName() == "font", "nested localName");

// --- 4. toString 往返（结构保留） ---
var s:String = xml.toString();
check(s.indexOf("<a") >= 0, "toString contains start tag");

trace("stage90 OK");
