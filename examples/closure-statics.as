// closure-statics.as — 闭包里的静态字段读必须跑类初始化（阶段二百六十九 · G22）
//
// AS3 规定：类的静态字段在**首次静态读之前**初始化一次（语言参考：static
// initializer / static properties）。闭包不会改变这条 —— 闭包只是一个值，调用它
// 读的是同一个静态 trait。
//
// 旧实现按**发射顺序**丢掉了守卫：闭包体由 `emitFunctionValues` 发射，而
// 「哪些类拥有 `_cinit`」的集合要到 `emitClassRegistry` / `emitStaticFields`
// 才被填。于是闭包里的静态读被发成裸槽读 `Owner_FIELD`，类的惰性初始化从未被
// 调用，C 槽还是 NULL —— `NAMES[0]` 直接抛 `TypeError #1009`。
//
// 这个缺陷**很难自己暴露**：同一类的静态字段只要有一处被**普通方法**读过，
// 那一处会调 `_cinit()`，而它是「整类一次」的开关 ⇒ 其余闭包读点看起来正常。
// 所以下面的每个方法都**只**在闭包里读静态（方法体其余部分只用字面量），
// 六段用例分别覆盖：本类数组 / 本类标量 / 跨类限定名 / 第二个静态 / 嵌套闭包 /
// 运行期初始化的静态（`seed()`）/ 读点再喂 `length` 与 `join`。
//
// 期望值全部经 adl 51.4.1 双 runtime 实测（asaotui/probes/g22-closure-statics/，
// 10 格逐字一致，且对生成的 C 做「每个静态读都带 `_cinit()` 守卫」的源级审计）。

function check(name:String, got:*, want:*):void
{
  if (String(got) != String(want)) {
    throw new Error("closure-statics: " + name + " got " + got + " want " + want);
  }
}

class Bag
{
  public static const NAMES:Array = ["alpha", "beta", "gamma"];
}

class Sealed
{
  // 初始化表达式需要运行期求值 ⇒ 这个类必须有 `_cinit()`。
  public static var VALUE:String = seed();

  private static function seed():String { return "block-set"; }
}

class Cases
{
  private static const NAMES:Array = ["alpha", "beta", "gamma"];
  private static const NUMBER:int = 7;
  private static const LIT:String = "cases";
  private static const CFG:Object = { mode: "cfg" };
  private static const PAIR:Array = ["x", "y"];

  // A) 本类静态数组，读点只在闭包里
  public static function ownArray():String
  {
    var f:Function = function ():String { return NAMES[1]; };
    return f();
  }

  // B) 本类静态标量（int）
  public static function ownScalar():int
  {
    var f:Function = function ():int { return NUMBER * 2; };
    return f();
  }

  // C) 对照：字面量 const。同类的 `_cinit` 照样会跑（守卫是类级开关），
  //    但这一类没有运行期初始化时它也必须能读 —— 见 ClosureLiteralOnly。
  public static function literal():String
  {
    var f:Function = function ():String { return LIT; };
    return f();
  }

  // D) 跨类限定名读另一个类的静态
  public static function otherClass():String
  {
    var f:Function = function ():String { return Bag.NAMES[2]; };
    return f();
  }

  // E) 第二个静态，与 A 共用一次 `_cinit`
  public static function second():String
  {
    var f:Function = function ():String { return PAIR[1]; };
    return f();
  }

  // F) 嵌套闭包：内层闭包才是读点
  public static function nested():String
  {
    var f:Function = function ():String {
      var inner:Function = function ():String { return NAMES[0]; };
      return inner();
    };
    return f();
  }

  // G) Object 字面量静态 + 动态属性读
  public static function objectStatic():String
  {
    var f:Function = function ():String { return CFG.mode; };
    return f();
  }

  // H) 运行期初始化的静态（`seed()`），只有闭包读
  public static function seeded():String
  {
    var f:Function = function ():String { return Sealed.VALUE; };
    return f();
  }

  // I) 读点再喂属性访问：NULL 槽会抛 #1009，而不是给错字符串
  public static function lengthRead():int
  {
    var f:Function = function ():int { return NAMES.length; };
    return f();
  }

  // J) 读点再喂方法调用
  public static function methodRead():String
  {
    var f:Function = function ():String { return NAMES.join("-"); };
    return f();
  }
}

// 对照类：只有字面量 const ⇒ 不产生 `_cinit`，闭包读必须保持裸槽读。
class ClosureLiteralOnly
{
  public static const TEXT:String = "literal-only";

  public static function read():String
  {
    var f:Function = function ():String { return TEXT; };
    return f();
  }
}

// ---- 本类静态，读点全在闭包里 ----
check("ownArray", Cases.ownArray(), "beta");
check("ownScalar", Cases.ownScalar(), 14);
check("literal const (class also owns a _cinit)", Cases.literal(), "cases");

// ---- 跨类 / 第二个静态 / 嵌套闭包 ----
check("otherClass", Cases.otherClass(), "gamma");
check("second static (same _cinit)", Cases.second(), "y");
check("nested closure", Cases.nested(), "alpha");

// ---- 运行期初始化的静态 ----
check("object static", Cases.objectStatic(), "cfg");
check("seeded static", Cases.seeded(), "block-set");

// ---- 读点再喂属性 / 方法 ----
check("length", Cases.lengthRead(), 3);
check("join", Cases.methodRead(), "alpha-beta-gamma");

// ---- 对照：没有运行期初始化的类不应被加上 `_cinit` ----
check("literal-only class", ClosureLiteralOnly.read(), "literal-only");

// ---- 重复调用：类初始化只跑一次，值必须稳定 ----
check("repeat call 1", Cases.ownArray(), "beta");
check("repeat call 2", Cases.ownArray(), "beta");

trace("closure-statics: all assertions passed");