// Regression: AS3 semantics that the AOT front end must preserve but that the C
// backend can easily get wrong. Each block below pins one previously broken
// behaviour:
//   1) `for each` evaluates its collection expression exactly once (AS3 spec);
//      re-evaluating it per iteration turns a getter into an infinite loop.
//   2) `x is T` on an Object-typed value must run a runtime tag check, not fold
//      to a constant (Object is the *static* type, not the dynamic one).
//   3) a Function value stored in an Object-typed slot must still report
//      typeof == "function" and be callable after an `as Function` cast.
//   4) `super.m` used as a *value* must be bound to the superclass
//      implementation, never dispatched through the receiver's vtable (the
//      latter recurses forever when the subclass overrides m).
//   5) hasOwnProperty / `in` must agree and must see inherited traits:
//      fields, accessors (getter or setter) and methods.
//   6) writing through a dynamic key on an Object-typed target must reach
//      accessor-backed properties (setter reflection), not silently vanish.
//   7) ByteArray.length is an accessor: assigning it resizes the buffer.
//   8) a constructor argument with side effects is evaluated once
//      (`new XML(ba.readUTF())` must consume the string only once).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ---------------------------------------------------------------- 1) for-each
var probeCalls:int = 0;
function probe():Array { probeCalls++; return [1, 2, 3]; }

var seen:int = 0;
for each (var n:Object in probe())
    seen += n as int;
check(probeCalls == 1, "for-each must evaluate its collection once (calls=" + probeCalls + ")");
check(seen == 6, "for-each must visit every element (sum=" + seen + ")");

var keys:int = 0;
for (var k:Object in probe())
    keys++;
check(probeCalls == 2, "for-in must evaluate its collection once (calls=" + probeCalls + ")");

// ------------------------------------------------------------- 2) is on Object
var oNum:Object = 1;
var oStr:Object = "s";
var oBool:Object = true;
check(oNum is Number && oNum is int, "boxed Number is Number/int");
check(oStr is String, "boxed String is String");
check(oBool is Boolean, "boxed Boolean is Boolean");
check(!(oNum is String), "Number is not String");
check((oNum as Number) == 1, "as Number unboxes the value");

// ------------------------------------------- 3) Function value in an Object slot
function twice(v:int):int { return v * 2; }
var fnSlot:Object = twice;
check(typeof fnSlot == "function", "function in an Object slot keeps typeof function");
var fnBack:Function = fnSlot as Function;
check(fnBack != null, "as Function recovers the callable value");
if (fnBack != null)
    check(fnBack(21) == 42, "recovered Function is callable");

// ------------------------------------------------------ 4) super.m as a value
class Base {
    public function label():String { return "base"; }
    public function twice(v:int):int { return v * 2; }
}

class Derived extends Base {
    public override function label():String { return "derived"; }
    public function callSuperDirect():String { return super.label(); }
    public function callSuperAsValue():String {
        var f:Function = super.label;      // must bind Base.label, not Derived.label
        return f();
    }
    public function callSuperArg():int {
        var f:Function = super.twice;
        return f(4);
    }
}

var d:Derived = new Derived();
check(d.label() == "derived", "virtual dispatch picks the override");
check(d.callSuperDirect() == "base", "super.m() calls the base implementation");
check(d.callSuperAsValue() == "base", "super.m as a value binds the base implementation");
check(d.callSuperArg() == 8, "super.m as a value keeps the base signature");

// ---------------------------------------------------------- 5) hasOwnProperty
class TraitBase {
    public var f:int = 1;
    public function get g():int { return 2; }
    public function get gs():int { return 3; }
    public function set gs(v:int):void { }
    public function m():int { return 4; }
}

class TraitDerived extends TraitBase {
    public var own:int = 5;
    public function get ownAccessor():int { return 6; }
}

var td:TraitDerived = new TraitDerived();
check(td.hasOwnProperty("own"), "own field");
check(td.hasOwnProperty("ownAccessor"), "own accessor");
check(td.hasOwnProperty("f"), "inherited field");
check(td.hasOwnProperty("g"), "inherited getter");
check(td.hasOwnProperty("gs"), "inherited getter+setter");
check(td.hasOwnProperty("m"), "inherited method");
check(!td.hasOwnProperty("nope"), "unknown name is not a trait");
check("f" in td && "g" in td && "gs" in td && "m" in td, "in agrees with hasOwnProperty");

// ---------------------------------------- 6) dynamic write to an accessor (setter)
class Holder {
    private var _value:int = 0;
    public function get value():int { return _value; }
    public function set value(v:int):void { _value = v; }
}

var holder:Holder = new Holder();
var anyTarget:Object = holder;                 // static type Object -> dynamic write
var propName:String = "value";
anyTarget[propName] = 7;
check(holder.value == 7, "dynamic write reached the setter (value=" + holder.value + ")");
check(anyTarget[propName] == 7, "dynamic read sees the accessor (value=" + anyTarget[propName] + ")");

// --------------------------------------------------------- 7) ByteArray.length
var ba:ByteArray = new ByteArray();
ba.writeUTFBytes("abcd");
check(ba.length == 4, "length after write");
ba.length = 8;                                  // grow: zero filled
check(ba.length == 8, "length assignment grows the buffer");
ba.position = 4;
check(ba.readByte() == 0 && ba.readByte() == 0, "grown bytes read back as zero");
ba.length = 2;                                  // shrink: clamps position
check(ba.length == 2, "length assignment shrinks the buffer");
check(ba.position <= ba.length, "position clamped to the new length");

// -------------------------------------------------------- 8) single evaluation
var xmlBytes:ByteArray = new ByteArray();
xmlBytes.writeUTF("<a><b>hi</b></a>");
xmlBytes.position = 0;
var doc:XML = new XML(xmlBytes.readUTF());       // readUTF must run exactly once
check(xmlBytes.position == xmlBytes.length, "XML constructor consumed the string once");
check(doc != null, "XML parsed from the single read");

// --------------------------------------------------------- 9) Vector GC tracing
interface IThing { function get value():int; }
class Thing implements IThing {
    private var _v:int;
    public function Thing(v:int) { _v = v; }
    public function get value():int { return _v; }
}

var things:Vector.<IThing> = new <IThing>[];
things.push(new Thing(11));
things.push(new Thing(22));
things.length = 4;                              // force a buffer growth (re-grey rule)
things[2] = new Thing(33);
System.gc();
check(things[0].value == 11 && things[1].value == 22 && things[2].value == 33,
      "interface Vector survives a collection after growth");

trace("reg-as3-semantics: ok");