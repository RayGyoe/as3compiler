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

trace("stage91 OK");
