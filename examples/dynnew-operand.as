// Dynamic class instantiation from a CONTAINER operand: `new arr[i]()`.
//
// This is away3d's Intermediate_MD5Animation idiom verbatim --
//   private const ANIM_CLASSES:Array = [HellKnight_Idle2, ...];
//   AssetLibrary.loadData(new ANIM_CLASSES[i](), null, ANIM_NAMES[i], ...)
// -- where the class reference is not a literal name, a `Class`-typed variable
// or a static field, but an ARRAY ELEMENT. The element's static type is `any`
// (Array indexing boxes), so the operand reaches codegen as a boxed as_value
// even though the value inside is a Class.
//
// Two AS3 rules are pinned here:
//   1. An operand of any of the three shapes that CAN carry a Class at runtime
//      (`class`, an Object-typed variable, and a boxed `*`/Array/Vector element)
//      is legal: `new <expr>()` is not a compile-time error just because the
//      static type is not literally `class`. AIR decides at RUNTIME.
//   2. A value that is NOT a Class throws AIR's TypeError #1007
//      ("Instantiation attempted on a non-constructor.") -- and the compiler must
//      never reinterpret a boxed primitive's payload as an `as_class*` and jump
//      through it (a crash where AIR throws).
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Bullet {
  public var power:int;
  public function Bullet() { this.power = 1; }
}

class Shell {
  public var power:int;
  public function Shell() { this.power = 9; }
}

class Pair {
  public var n:int;
  public var tag:String;
  public function Pair(n:int, tag:String) { this.n = n; this.tag = tag; }
}

class Holder {
  public var list:Array;
  public function Holder() { this.list = [Shell]; }
}

// --- 1) Array element holding a Class value (the 1:1 ANIM_CLASSES shape) ---
var kinds:Array = [Bullet, Shell];
var a:Object = new kinds[0]();
check(a is Bullet, "new arr[0]() must build a Bullet");
check((a as Bullet).power == 1, "the constructed instance keeps its ctor state");
var b:Object = new kinds[1]();
check(b is Shell, "a different element builds a different class");
check(a !== b, "each instantiation allocates a fresh instance");

// The index is a LOOP variable in the real code, not a literal.
var i:uint = 1;
var c:Object = new kinds[i]();
check(c is Shell, "new arr[i]() with a variable index");

// --- 2) Vector.<Class> element (SingleFileLoader._parsers' shape) ---
var parsers:Vector.<Class> = Vector.<Class>([Bullet]);
var d:Object = new parsers[0]();
check(d is Bullet, "new vec[0]() must build the element class");

// --- 3) a member chain ending in an index ---
var h:Holder = new Holder();
var e:Object = new h.list[0]();
check(e is Shell, "new obj.list[0]() must build the element class");

// --- 4) arguments travel through the registered constructor thunk ---
var ctors:Array = [Pair];
var p:Object = new ctors[0](3, "x");
check(p is Pair, "new arr[0](a, b) must build the element class");
check((p as Pair).n == 3 && (p as Pair).tag == "x", "ctor arguments must arrive");

// --- 5) a non-Class operand is AIR's TypeError #1007, at RUNTIME ---
// Each of these is a legal program that fails only when it runs.
function expect1007(what:String, f:Function):void {
  var threw:Boolean = false;
  try {
    f();
  } catch (err:TypeError) {
    threw = true;
    check(err.errorID == 1007, what + ": expected errorID 1007, got " + err.errorID);
  }
  check(threw, what + ": must throw TypeError #1007");
}

// A String operand: its payload is a char*, which must not be followed as a class.
var badStr:any = "not a class";
expect1007("String operand", function ():void { var x:Object = new (badStr)(); });

// A Number operand: the payload word is not even a pointer.
var badNum:any = 42;
expect1007("Number operand", function ():void { var x:Object = new (badNum)(); });

// A Boolean operand.
var badBool:any = true;
expect1007("Boolean operand", function ():void { var x:Object = new (badBool)(); });

// An ordinary OBJECT INSTANCE: boxed as tag 4 exactly like a Class is, so the
// tag alone cannot tell them apart -- only the class-object storage can.
var instance:any = new Bullet();
expect1007("instance operand", function ():void { var x:Object = new (instance)(); });

// An Array operand (tag 6).
var arrVal:any = [1, 2];
expect1007("Array operand", function ():void { var x:Object = new (arrVal)(); });

// null / undefined.
var nullVal:any = null;
expect1007("null operand", function ():void { var x:Object = new (nullVal)(); });

// The container spelling: the bad value arrives through an Array element and a
// Vector element, exactly like the legal cases above.
var badArr:Array = ["nope"];
expect1007("Array-element operand", function ():void { var x:Object = new badArr[0](); });
var badVec:Vector.<Class> = Vector.<Class>([null]);
expect1007("Vector-element operand", function ():void { var x:Object = new badVec[0](); });

// --- 6) the Object-typed-variable shape stays working (fail-closed too) ---
var objRef:Object = Bullet;
var f:Object = new (objRef)();
check(f is Bullet, "new (objectVar)() holding a Class");
var notClass:Object = "still not a class";
expect1007("Object-typed non-Class", function ():void { var x:Object = new (notClass)(); });

// --- 7) `is Class` and `new` are the SAME predicate, so they cannot disagree ---
// `if (x is Class) new x()` is the idiom away3d's Cast uses; if the two tests ever
// drifted apart (one tag-based, one registry-based), that guard would be useless.
check(Bullet is Class, "a Class value is Class");
check(kinds[0] is Class, "an Array element holding a Class is Class");
check(!(badStr is Class), "a String is not Class");
check(!(badNum is Class), "a Number is not Class");
check(!(instance is Class), "an instance is not Class");
check(!(arrVal is Class), "an Array is not Class");
check(!(nullVal is Class), "null is not Class");

// ...and the agreement is observable end to end: the guard lets through exactly
// the values `new` accepts.
function build(candidate:Object):Object {
  if (candidate is Class) return new (candidate)();
  return null;
}
check(build(Bullet) is Bullet, "the is-Class guard builds a real Class");
check(build("nope") == null, "the is-Class guard rejects a non-Class");

trace("dynnew-operand: all assertions passed");