// stage91.as — E4X @attr 属性访问 + .child 子节点导航（阶段九十一）。
//
// 覆盖：@attr、.child 子节点导航、多级导航、XMLList.length()、for-each 迭代。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. @attr 属性访问 ---
var atlas:XML = new XML(
  "<TextureAtlas imagePath='atlas.png'>" +
  "<SubTexture name='a' x='0' y='0'/>" +
  "<SubTexture name='b' x='32' y='0'/>" +
  "</TextureAtlas>"
);
check(atlas.@imagePath == "atlas.png", "@imagePath");
check(atlas.@imagePath.toString() == "atlas.png", "@imagePath.toString()");

// --- 2. .child 子节点导航返回 XMLList + length() ---
var subs:XMLList = atlas.SubTexture;
check(subs.length() == 2, "SubTexture count");

// --- 3. for-each 迭代 XMLList ---
var names:String = "";
for each (var sub:XML in atlas.SubTexture) {
  names += sub.@name + ",";
}
check(names == "a,b,", "for-each over XMLList");

// --- 4. 多级 .child + @attr（模拟 BitmapFont / XmlFactory）---
var font:XML = new XML("<font><info face='Arial' size='12'/><pages><page id='0' file='arial.png'/></pages></font>");
check(font.info.@face == "Arial", "font.info.@face");
check(font.pages.page.@file == "arial.png", "font.pages.page.@file");

// --- 5. 多元素 XMLList 的 @attr 标量上下文 = 拼接串（E4X）---
// adl 51.4.1（temp/qfix/xmlattr.body.as）：list.@attr 在标量上下文把每个条目的
// 属性值按文档序拼接、无分隔符；缺失/空值不计入。单元素形态以上已覆盖，这里钉多元素。
var multi:XML = new XML("<r><item at='1'/><item at='2'/></r>");
check(multi.item.@at == "12", "multi-item @attr concatenates");
check(multi.item.@at.toString() == "12", "multi-item @attr .toString()");
check(multi.item.@["at"] == "12", "multi-item @[\"at\"] concatenates");
var three:XML = new XML("<r><item at='a'/><item at='b'/><item at='c'/></r>");
check(three.item.@at == "abc", "three-item @attr concatenates");
var partial:XML = new XML("<r><item at='1'/><item/></r>");
check(partial.item.@at == "1", "missing attribute contributes nothing");
var none:XML = new XML("<r><item/><item/></r>");
check(none.item.@at == "", "no attributes at all yields empty string");

trace("stage91 OK");
