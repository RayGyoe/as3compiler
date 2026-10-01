// stage86.as — 阶段八十六：flash.utils 反射 API（getQualifiedClassName / getDefinitionByName）。
//
// 覆盖：
//  1. getQualifiedClassName：原始类型（null/Number/Boolean/String）+ 对象实例（包::类）+
//     继承链（子类返回自身 fqn）+ 无包类 + Class 值 + Array
//  2. getDefinitionByName：`::`/`.` 两种分隔符 + 往返闭环 + 动态实例化 + 找不到抛 ReferenceError
//
// 纯 C 回归：断言三函数语义，无窗口/GPU 依赖。包内类经短名引用（typeAlias 解析），
// 但 getQualifiedClassName 返回的限定名含完整 "scenes::" 前缀（编译期从 packageName 拼出）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 包内类：限定名 = "scenes::Scene1" / "scenes::Scene2"
package scenes {
  class Scene1 {
    public function Scene1() {}
    public function label():String { return "Scene1"; }
  }
  class Scene2 extends Scene1 {
    public function Scene2() {}
  }
}

// 无包类：限定名 = "Thing"（短名，无 :: 前缀）
class Thing {
  public function Thing() {}
}

// ===== 1. getQualifiedClassName 原始类型 =====
check(getQualifiedClassName(null) == "null", "null -> null");
check(getQualifiedClassName(3.14) == "Number", "Number -> Number");
check(getQualifiedClassName(true) == "Boolean", "Boolean -> Boolean");
check(getQualifiedClassName("hi") == "String", "String -> String");

// ===== 2. getQualifiedClassName 对象实例（包::类） =====
var s1:Scene1 = new Scene1();
check(getQualifiedClassName(s1) == "scenes::Scene1", "instance -> scenes::Scene1");

// ===== 3. 继承链：子类返回自身 fqn =====
var s2:Scene2 = new Scene2();
check(getQualifiedClassName(s2) == "scenes::Scene2", "subclass -> scenes::Scene2");

// ===== 4. 无包类 =====
var t:Thing = new Thing();
check(getQualifiedClassName(t) == "Thing", "no-package -> Thing");

// ===== 5. 数组 =====
var arr:Array = [1, 2, 3];
check(getQualifiedClassName(arr) == "Array", "Array -> Array");

// ===== 6. getDefinitionByName：:: 分隔符 + 动态实例化 =====
var cls:Class = getDefinitionByName("scenes::Scene1") as Class;
check(cls != null, "getDefinitionByName :: found");
check(getQualifiedClassName(cls) == "scenes::Scene1", "Class value -> fqn");
var inst:Scene1 = new (cls)() as Scene1;
check(inst != null, "dynamic instantiation");
check(inst.label() == "Scene1", "dynamic instance method");

// ===== 7. getDefinitionByName：. 分隔符 =====
var cls2:Class = getDefinitionByName("scenes.Scene1") as Class;
check(cls2 != null, "getDefinitionByName . found");

// ===== 8. 往返闭环：getQualifiedClassName -> getDefinitionByName =====
var n:String = getQualifiedClassName(s2);
check(n == "scenes::Scene2", "roundtrip name");
var cls3:Class = getDefinitionByName(n) as Class;
check(cls3 != null, "roundtrip definition");
var inst3:Scene2 = new (cls3)() as Scene2;
check(inst3 != null, "roundtrip instantiate");

// ===== 9. 找不到抛 ReferenceError =====
var threw:Boolean = false;
try {
  getDefinitionByName("flash.desktop::NativeApplication");
} catch (e:ReferenceError) {
  threw = true;
}
check(threw, "missing definition throws ReferenceError");

trace("stage86 OK");
