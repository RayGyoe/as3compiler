// stage93.as — 阶段九十三：describeType 的 XML 输出。
//
// 覆盖：describeType(Class) 返回 <type name="包::类"/> XML 树，@name/.localName()
// 可遍历；非 Class 值退回 <type name="Object"/>。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

package scenes {
  class Scene1 {
    public function Scene1() {}
  }
}

// 1. describeType(Class) -> <type name="scenes::Scene1"/>
var cls:Class = getDefinitionByName("scenes::Scene1") as Class;
check(cls != null, "got Class");
var typeXml:XML = describeType(cls);
check(typeXml.@name == "scenes::Scene1", "describeType @name");
check(typeXml.localName() == "type", "describeType localName");
check((typeXml.@name).split("::").pop() == "Scene1", "describeType name split");

// 2. 过滤谓词与 describeType 的 XML 树兼容（constant/variable 为空）
check(typeXml.constant.(@type == "Class").length() == 0, "no Class constants");
check(typeXml.variable.(@type == "Class").length() == 0, "no Class variables");

// 3. 非 Class 值退回 Object 描述
var t2:XML = describeType({ a: 1 });
check(t2.@name == "Object", "describeType object fallback");

trace("stage93 OK");
