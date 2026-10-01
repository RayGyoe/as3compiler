// Reflection-based instantiation: `Object(x).constructor as Class` + `new c()`.
//
// Two AS3 rules this pins down:
//  1. `new Foo()` is legal whenever EVERY constructor parameter has a default.
//     Such a class gets a generated `Foo_new_default()` entry point, so the
//     class registry never stores a NULL factory for it.
//  2. A class with a REQUIRED constructor parameter is NOT constructible with no
//     arguments; AS3 throws ArgumentError #1063. The subset previously stored a
//     NULL factory and dereferenced it (SIGSEGV).
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class AllOpt {
  public var a:int;
  public var b:String;
  public function AllOpt(a:int = 7, b:String = "def") { this.a = a; this.b = b; }
}

class WithReq {
  public var a:int;
  public function WithReq(a:int) { this.a = a; }
}

class NoArgs {
  public var n:int;
  public function NoArgs() { this.n = 42; }
}

// --- 1) all-optional params: reflection `new` supplies the defaults ---
var src:AllOpt = new AllOpt(3, "x");
check(src.a == 3 && src.b == "x", "explicit ctor args");
var cls:Class = Object(src).constructor as Class;
var made:Object = new (cls as Class)();
var madeAll:AllOpt = made as AllOpt;
check(madeAll != null, "reflection new must return an AllOpt instance");
check(madeAll.a == 7, "default int param applied, got " + madeAll.a);
check(madeAll.b == "def", "default String param applied, got " + madeAll.b);
check(madeAll != src, "reflection new allocates a fresh instance");
check(src.a == 3, "the original instance is untouched");

// --- 2) required param: loud ArgumentError, never a null-pointer call ---
var wr:WithReq = new WithReq(1);
var cls2:Class = Object(wr).constructor as Class;
var threw:Boolean = false;
var msg:String = "";
try {
  var bad:Object = new (cls2 as Class)();
  msg = "constructed (should not have)";
} catch (e:Error) {
  threw = true;
  msg = e.message;
}
check(threw, "reflection new on a required-arg class must throw, got: " + msg);

// --- 3) no-param class keeps working through the same path ---
var na:NoArgs = new NoArgs();
var cls3:Class = Object(na).constructor as Class;
var na2:NoArgs = new (cls3 as Class)() as NoArgs;
check(na2 != null && na2.n == 42, "no-arg reflection new");

trace("class-reflect-new: all assertions passed");