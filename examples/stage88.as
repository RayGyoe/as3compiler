// stage88.as — AS3 语言特性缺口（Starling 编译硬阻塞，stage 88）。
//
// 覆盖：对象字面量字符串键 / ||=·&&= / for each 无 var / :*= 任意类型默认值 /
// new <T>[] 泛型字面量 / Error 子类 super(message, id) 二参 / super.property
// 读·写 / 全限定名 is·as·new / namespace（声明·use namespace·限定调用·修饰成员）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. 对象字面量字符串键 ---
var sizes:Object = { "bytes4": 4, "float1": 4, "float2": 8, "float3": 12 };
check(sizes["bytes4"] == 4, "string key bytes4");
check(sizes["float2"] == 8, "string key float2");
check(sizes["float3"] == 12, "string key float3");

// --- 2. 逻辑赋值 ||= / &&= ---
var out:Vector.<int> = null;
out ||= new Vector.<int>();
check(out != null, "||= assigns when null");
out.push(1);
var alias:Vector.<int> = out;
alias ||= new Vector.<int>();
check(alias == out, "||= no-op when truthy");

var dirty:Boolean = false;
dirty ||= (1 == 2);
check(dirty == false, "||= keeps false when rhs false");
dirty ||= (1 == 1);
check(dirty == true, "||= assigns true");

var keep:Boolean = true;
keep &&= (2 > 1);
check(keep == true, "&&= truthy stays truthy");
keep &&= (2 < 1);
check(keep == false, "&&= assigns false");

// --- 3. for each 无 var ---
var arr:Array = [10, 20, 30];
var sum:int = 0;
var x:int;
for each (x in arr) { sum += x; }
check(sum == 60, "for each without var");

// --- 4. :* 任意类型默认值（紧贴 :*=）---
check(defaultMsg() == "", ":*= default empty");
check(defaultMsg("hi") == "hi", ":*= explicit");

// --- 5. new <T>[] 泛型字面量 ---
var empty:Vector.<int> = new <int>[];
check(empty.length == 0, "new <int>[] empty");
var lit:Vector.<Number> = new <Number>[1.5, 2.5];
check(lit.length == 2, "new <Number>[...] elements");
check(lit[1] == 2.5, "new <Number>[...] value");

// --- 6. Error 子类 super(message, id) 二参 ---
var myErr:MyError = new MyError("boom", 42);
check(myErr.message == "boom", "Error message via super(message, id)");
check(myErr.id == 42, "Error id via super(message, id)");

// --- 7. super.property 读·写 ---
var d:Dog = new Dog();
check(d.baseName() == "Animal", "super.property read (field)");
d.setup();
check(d.baseName() == "Rex", "super.property write (field)");
check(d.baseLabel() == "L:Rex", "super.property read (getter)");

// --- 8. 全限定名 is / as / new ---
var foo:com.example.Foo = new com.example.Foo();
check(foo is com.example.Foo, "qualified is");
check((foo as com.example.Foo) != null, "qualified as");
check(foo.width == 256, "qualified new field");
check(!(null is com.example.Foo), "qualified is (null)");

// --- 9. namespace（声明 / use namespace / 限定调用 / 修饰成员）---
var m:Machine = new Machine();
check(m.run() == 42, "namespace-qualified instance call");
check(m.runStatic() == 42, "Class.ns::method static call");
var w:Widget = new Widget();
check(w.run() == 7, "use namespace + qualified call");

trace("stage88 OK");

// ===== 声明 =====

// :*= 任意类型 + 默认值（无空格紧贴，触发 lexer :*= 拆分）
function defaultMsg(message:*=""):String { return message; }

// Error 子类：super(message, id) 二参（AIR Error(message, id) 签名）
class MyError extends Error {
  public var id:int;
  public function MyError(message:String = "", id:int = 0) {
    super(message, id);
    this.id = id;
  }
}

// super.property 读·写：字段 + getter
class Animal {
  public var name:String = "Animal";
  public function get label():String { return "L:" + name; }
}
class Dog extends Animal {
  public function setup():void { super.name = "Rex"; }
  public function baseName():String { return super.name; }
  public function baseLabel():String { return super.label; }
}

// 全限定名目标类型（package 内定义，用 com.example.Foo 访问）
package com.example {
  public class Foo {
    public var width:int = 256;
  }
}

// namespace 声明（Starling 的 starling_internal 模式）
public namespace starling_internal;

class Machine {
  starling_internal function secretValue():int { return 42; }
  starling_internal static function fromPool(n:int):int { return n * 2; }
  public function run():int { return starling_internal::secretValue(); }
  public function runStatic():int { return Machine.starling_internal::fromPool(21); }
}

class Widget {
  use namespace starling_internal;
  starling_internal function helper():int { return 7; }
  public function run():int { return starling_internal::helper(); }
}
