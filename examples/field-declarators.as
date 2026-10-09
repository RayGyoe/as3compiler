// field-declarators.as — 阶段一百零八：类体一条 `var`/`const` 声明**多个**字段。
//
// 第二处 away3d-core 暴露的语言层缺口（examples/away3d-core 的
// away3d/materials/methods/{BasicAmbient,BasicDiffuse,BasicSpecular}Method.as：
// `private var _r:Number = 0, _g:Number = 0, _b:Number = 0;`），此前只收单个
// declarator，逗号直接 ParseError。函数体内的多声明符（`var a:int = 1, b:int = 2;`）
// 早已支持，缺的是**类体**这条分支。
//
// 每个 declarator 必须是**独立的字段**（各自的槽、各自的初始化器），且静态字段
// 按书写顺序初始化、可引用前面已声明的字段（AIR 同此：静态初始化按声明顺序执行）。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Material {
  public var r:Number = 0.25, g:Number = 0.5, b:Number = 0.75;
  public var label:String = "base", tag:String;
  public static var base:int = 3, derived:int = base * 2;
  public static var sr:int = 1, sg:int = 2;
  public static const K:int = 9, L:int = 10, M:int = 11;
  public function Material():void { }
  public function sum():Number { return r + g + b; }
}

// 每个 declarator 是自己的槽：改一个不影响另一个。
var m:Material = new Material();
check(m.r == 0.25 && m.g == 0.5 && m.b == 0.75, "each declarator is initialized independently");
m.r = 1;
check(m.g == 0.5 && m.b == 0.75, "writing one declarator leaves its siblings untouched");
check(m.sum() == 2.25, "the fields participate in methods as ordinary instance fields");

// 独立的实例：不是共享的静态槽。
var m2:Material = new Material();
check(m2.r == 0.25, "each instance gets its own copy of every declarator");

// 有类型的与无类型的声明混在一条里。
check(m.label == "base" && m.tag == null, "a typed and an untyped declarator share one statement");

// 一条声明里的 `const`。
check(Material.K == 9 && Material.L == 10 && Material.M == 11, "a const declaration may list several constants");

// 静态 declarator 按书写顺序初始化，且后者可引用前者。
check(Material.base == 3 && Material.derived == 6,
  "static declarators initialize in declaration order and may read the earlier ones");
Material.sr = 5;
check(Material.sr == 5 && Material.sg == 2, "static declarators are separate slots too");

trace("field-declarators: class-body multi-declarator var/const OK");