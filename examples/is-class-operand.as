// Stage 99: `is` / `as` with a runtime Class VALUE as the right operand.
//
// AS3 resolves `x is Name` in the SCOPE first, so a variable or parameter of type
// `Class` is a runtime class object, not a type name. AIR then walks the real
// super chain, so the check is a subtype test against whatever class the value
// holds. A right operand that holds no class object at all (a `Class` slot holding
// null) throws TypeError #1009 -- for `is` AND for `as`. All expectations below are
// measured on adl 51.4.1 (temp/cisprobe/cis-result.txt).

class Animal {
  public var tag:String = "animal";
}
class Dog extends Animal {
  public function Dog():void { tag = "dog"; }
}
class Cat extends Animal { }
class Rock { }
class Zoo {
  // A Class-typed FIELD (`lookupClassVar` resolves fields too).
  public var favorite:Class = Dog;
  public function has(it:*, c:Class):Boolean { return it is c; }
}

function isDog(it:*, c:Class):Boolean { return it is c; }
function asDog(it:*, c:Class):* { return it as c; }
function pick(list:Array, cls:Class):Array {
  var out:Array = [];
  for each (var it:* in list) { if (it is cls) out.push(it); }
  return out;
}

var dogClass:Class = Dog;
var catClass:Class = Cat;
var animalClass:Class = Animal;
var rockClass:Class = Rock;
var nullClass:Class = null;

var failures:int = 0;
function check(cond:Boolean, msg:String):void {
  if (!cond) { failures++; trace("FAIL: " + msg); }
}

// ---- 1. class-variable right operand: subtype walking (adl A1-A7) ----
check((new Dog() is dogClass) == true, "a Dog is the Dog class");
check((new Cat() is catClass) == true, "a Cat is the Cat class");
check((new Dog() is animalClass) == true, "a Dog is the Animal class (up the chain)");
check((new Animal() is dogClass) == false, "an Animal is not a Dog (no down the chain)");
check((new Dog() is catClass) == false, "a Dog is not the Cat class");
check((new Rock() is animalClass) == false, "an unrelated class never matches");
check((new Dog() is rockClass) == false, "an unrelated target never matches");
check((null is dogClass) == false, "null is never an instance");

// ---- 2. the same test through a helper (the ShapeSkin case) ----
check(isDog(new Dog(), dogClass) == true, "helper: Dog is Dog");
check(isDog(new Cat(), dogClass) == false, "helper: Cat is not Dog");
check(isDog(new Cat(), animalClass) == true, "helper: Cat is Animal");
check(new Zoo().has(new Dog(), dogClass) == true, "a method can pass a Class parameter through");
check(new Zoo().favorite == dogClass, "a Class-typed field holds the same class object");

// ---- 3. `as` yields the value or null (adl B1-B4) ----
check((new Dog() as dogClass) != null, "as: a Dog casts to the Dog class");
check((new Cat() as dogClass) == null, "as: a Cat fails to cast to the Dog class");
check((new Dog() as animalClass) != null, "as: a Dog casts to Animal");
check((null as dogClass) == null, "as: null stays null");
var castResult:Animal = new Dog() as animalClass;
check(castResult.tag == "dog", "as: the cast keeps the very same object");

// ---- 4. dynamic (`*`) left operand uses the RUNTIME class of the value (adl G1-G4) ----
var dyn:* = new Dog();
check((dyn is dogClass) == true, "a * holding a Dog is the Dog class");
check((dyn is animalClass) == true, "a * holding a Dog is the Animal class");
check((dyn as dogClass) != null, "a * holding a Dog casts to Dog");
dyn = new Rock();
check((dyn is dogClass) == false, "a * holding a Rock is not the Dog class");
check((dyn is rockClass) == true, "a * holding a Rock is the Rock class");

// ---- 5. filtering a heterogeneous list (the real-world use) ----
var list:Array = [new Dog(), new Cat(), new Dog(), new Rock()];
check(pick(list, dogClass).length == 2, "pick: two Dogs");
check(pick(list, catClass).length == 1, "pick: one Cat");
check(pick(list, animalClass).length == 3, "pick: three Animals");
check(pick(list, rockClass).length == 1, "pick: one Rock");

// ---- 6. a right operand holding no class object throws TypeError #1009 (adl E1-E3) ----
var thrownIs:int = 0;
try { var ignored1:Boolean = new Dog() is nullClass; } catch (e:Error) { thrownIs = e.errorID; }
check(thrownIs == 1009, "a null Class slot throws #1009 from `is` (got " + thrownIs + ")");
var thrownAs:int = 0;
try { var ignored2:* = new Dog() as nullClass; } catch (e:Error) { thrownAs = e.errorID; }
check(thrownAs == 1009, "a null Class slot throws #1009 from `as` (got " + thrownAs + ")");
var thrownScalar:int = 0;
try { var ignored3:Boolean = 5 is nullClass; } catch (e:Error) { thrownScalar = e.errorID; }
check(thrownScalar == 1009, "the operand is validated before the left side (got " + thrownScalar + ")");

// ---- 7. a primitive left operand can never match, but does not throw ----
var n:int = 5;
check((n is dogClass) == false, "an int is never an instance of a user class");
check((n is animalClass) == false, "an int is not an Animal");
check(("str" is dogClass) == false, "a String is never an instance of a user class");
check((n as dogClass) == null, "as: an int yields null");

// ---- 8. the type-name form is unaffected (regression guard) ----
check((new Dog() is Animal) == true, "literal: a Dog is Animal");
check((new Animal() is Dog) == false, "literal: an Animal is not a Dog");
check((new Dog() as Animal) != null, "literal as: a Dog casts to Animal");
check((new Dog() as Cat) == null, "literal as: a Dog does not cast to Cat");
check(("x" is String) == true, "literal: a String is a String");
check(([1] is Array) == true, "literal: an Array is an Array");
check((1 is Object) == true, "literal: a primitive is an Object");

// ---- 9. `is` and `as` compose: a cast then a check ----
var casted:* = new Dog() as animalClass;
check((casted is dogClass) == true, "a cast does not lose the runtime class");

// ---- 10. `is Object` holds for EVERY value except null/undefined ----
// adl 51.4.1 (temp/cisprobe/islit-result.txt O1-O27): primitives, arrays, records,
// functions and class instances are all Objects; null and undefined are not. A
// boxed value in a `*` slot is an Object too, so the rule is tag-based.
check((1 is Object) == true, "an int is an Object");
check((1.5 is Object) == true, "a Number is an Object");
check(("x" is Object) == true, "a String is an Object");
check((true is Object) == true, "a Boolean is an Object");
check(([1] is Object) == true, "an Array is an Object");
check((new Dog() is Object) == true, "an instance is an Object");
check((null is Object) == false, "null is not an Object");
check((undefined is Object) == false, "undefined is not an Object");
var aFn:Function = function():void { };
check((aFn is Object) == true, "a function value is an Object");
var aNum:* = 5;
var aBool:* = true;
var aStr:* = "s";
var anArr:* = [1];
var aObj:* = new Dog();
check((aNum is Object) == true, "a boxed number is an Object");
check((aBool is Object) == true, "a boxed Boolean is an Object");
check((aStr is Object) == true, "a boxed String is an Object");
check((anArr is Object) == true, "a boxed Array is an Object");
check((aObj is Object) == true, "a boxed instance is an Object");
var aNull:* = null;
var aUndef:* = undefined;
check((aNull is Object) == false, "a boxed null is not an Object");
check((aUndef is Object) == false, "a boxed undefined is not an Object");

if (failures == 0) trace("is-class-operand: all assertions passed");
else trace("is-class-operand: " + failures + " FAILURES");