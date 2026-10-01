// stage92.as — E4X 过滤谓词 .( @attr == value )（阶段九十二）。
//
// 覆盖：xml.child.(@attr == "str") 过滤，返回 XMLList，供 length()/for-each 消费。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 模拟 Starling 的 describeType / AssetManager 元数据提取场景
var typeXml:XML = new XML(
  "<type name='Test'>" +
  "<constant name='A' type='int'/>" +
  "<constant name='B' type='Class'/>" +
  "<variable name='x' type='Class'/>" +
  "<variable name='y' type='int'/>" +
  "</type>"
);

// 1. 过滤 constant 节点中 @type == "Class"
var clsConsts:XMLList = typeXml.constant.(@type == "Class");
check(clsConsts.length() == 1, "constant filter count");

var found:String = "";
for each (var c:XML in typeXml.constant.(@type == "Class")) {
  found += c.@name;
}
check(found == "B", "filtered constant name");

// 2. 过滤 variable 节点
var found2:String = "";
for each (var v:XML in typeXml.variable.(@type == "Class")) {
  found2 += v.@name;
}
check(found2 == "x", "filtered variable name");

// 3. 多级导航 + 过滤（模拟 BitmapFont pages）
var font:XML = new XML(
  "<font><pages><page id='0' file='arial.png'/><page id='1' file='bold.png'/></pages></font>"
);
var page0:String = "";
for each (var p:XML in font.pages.page.(@id == "0")) {
  page0 += p.@file;
}
check(page0 == "arial.png", "filtered page file");

// 4. 空结果集
check(font.pages.page.(@id == "99").length() == 0, "empty filter");

trace("stage92 OK");
