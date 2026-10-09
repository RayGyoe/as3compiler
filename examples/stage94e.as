// 阶段九十四·五 — AIR fidelity batch: cast / reflection / `with` gaps closed.
// Every golden below was measured on adl 51.4.1 (probe temp/a3probe/ for the
// `as Object` group), so these are differential assertions, not guesses.
import flash.utils.getQualifiedClassName;
import flash.utils.ByteArray;
import flash.net.registerClassAlias;
import flash.utils.getQualifiedSuperclassName;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

// ---- `x as Object` (measured on adl 51.4.1) ------------------------------
// AS3 treats primitives as Objects, so `as Object` never nulls a value out;
// the old emitter returned a literal NULL for every non-object operand, which
// silently dropped a record's dynamic slots.
var rec:* = {k: "v"};
var recObj:Object = rec as Object;
check(recObj != null, "a record cast to Object is not null");
check(recObj.k == "v", "a record cast to Object keeps its dynamic members, got " + recObj.k);

var litObj:Object = ({k: "w"}) as Object;
check(litObj.k == "w", "a record literal cast to Object keeps its dynamic members, got " + litObj.k);

var implicitObj:Object = rec;
check(implicitObj.k == "v", "an implicit record -> Object conversion still keeps its members");

var objFnObj:Object = Object(rec);
check(objFnObj.k == "v", "Object(record) still keeps its dynamic members");

var anyArr:* = [1, 2];
var arrObj:Object = anyArr as Object;
check(arrObj != null, "an array cast to Object is not null");

var nl:* = null;
check((nl as Object) == null, "null as Object is null");
var undef:* = undefined;
check((undef as Object) == null, "undefined as Object is null (measured on adl)");

// A primitive cast to Object auto-boxes and round-trips back through `as Number`.
var num5:Number = 5;
var boxed5:Object = num5 as Object;
check(boxed5 != null, "a Number cast to Object is not null");
check((boxed5 as Number) == 5, "a boxed Number round-trips through `as Number`");

// The real-world shape that hit the bug: a dynamic member read through `*`,
// then cast — the nested record must still be reachable by key.
var holder:* = {props: {rotationX: 2}};
var props:Object = holder.props as Object;
check(props.rotationX == 2, "a nested record survives `holder.props as Object`, got " + props.rotationX);

// ---- calling a Function-valued member (measured on adl 51.4.1) -----------
// `cb.fn()` and `with (cb) { fn() }` both invoke the stored function: AIR
// rebinds `this` to the receiver for those two forms (a bare `fn()` keeps the
// global object). Our closures capture `this` lexically at creation, so this
// example pins the forms where both sides agree — a method reference, which
// already carries its own receiver. The rebinding delta for plain closures is
// registered in TODO.md 遗留 (see temp/a4probe/ for the measured adl table).
class Runner {
	public var fn:Function;
	public var tag:String = "cbtag";
	public function Runner() {}
	public function who():String { return "who:" + this.tag; }
	public function callDotted():String { return String(this.fn()); }
	public function callBare():String { return String(fn()); }
}

var runner:Runner = new Runner();
runner.fn = runner.who;
check(runner.callDotted() == "who:cbtag", "a dotted call of a Function-valued field runs it, got " + runner.callDotted());
check(runner.callBare() == "who:cbtag", "a bare call of a Function-valued field runs it, got " + runner.callBare());
var viaWith:String = "";
with (runner) { viaWith = String(fn()); }
check(viaWith == "who:cbtag", "a `with` call of a Function-valued field runs it, got " + viaWith);

// ---- Vector reflection names (measured on adl 51.4.1) --------------------
// A Vector is a monomorphized C struct with no vtable, so adl names it by
// element type: "__AS3__.vec::Vector.<element>". The SUPERCLASS depends on the
// element kind -- a numeric element type (int/uint/Number) extends Object, while
// every reference element type extends "__AS3__.vec::Vector.<*>" (including
// String/Boolean/Object/Array, a class, an interface, and a nested vector).
class Kite {
	public var span:Number = 0;
	public function Kite() {}
}

var vInt:Vector.<int> = new <int>[1, 2];
check(getQualifiedClassName(vInt) == "__AS3__.vec::Vector.<int>",
	"Vector.<int> names itself, got " + getQualifiedClassName(vInt));
check(getQualifiedSuperclassName(vInt) == "Object",
	"Vector.<int> extends Object, got " + getQualifiedSuperclassName(vInt));

var vUint:Vector.<uint> = new <uint>[1];
check(getQualifiedClassName(vUint) == "__AS3__.vec::Vector.<uint>",
	"Vector.<uint> keeps uint distinct from int, got " + getQualifiedClassName(vUint));

var vNum:Vector.<Number> = new <Number>[1.5];
check(getQualifiedClassName(vNum) == "__AS3__.vec::Vector.<Number>",
	"Vector.<Number> names itself, got " + getQualifiedClassName(vNum));

var vStr:Vector.<String> = new <String>["a"];
check(getQualifiedClassName(vStr) == "__AS3__.vec::Vector.<String>",
	"Vector.<String> names itself, got " + getQualifiedClassName(vStr));
check(getQualifiedSuperclassName(vStr) == "__AS3__.vec::Vector.<*>",
	"a reference-element Vector extends Vector.<*>, got " + getQualifiedSuperclassName(vStr));

var vBool:Vector.<Boolean> = new <Boolean>[true];
check(getQualifiedSuperclassName(vBool) == "__AS3__.vec::Vector.<*>",
	"Vector.<Boolean> extends Vector.<*>, got " + getQualifiedSuperclassName(vBool));

var vPoint:Vector.<Kite> = new <Kite>[new Kite()];
check(getQualifiedClassName(vPoint) == "__AS3__.vec::Vector.<Kite>",
	"a user class element uses the class's own name, got " + getQualifiedClassName(vPoint));

var vNested:Vector.<Vector.<int>> = new <Vector.<int>>[new <int>[3]];
check(getQualifiedClassName(vNested) == "__AS3__.vec::Vector.<__AS3__.vec::Vector.<int>>",
	"a nested vector element is named recursively, got " + getQualifiedClassName(vNested));

// ---- AMF3 trait member order (our rule; AIR's is a layout artifact) ------
// Measured on adl 51.4.1 (temp/a6probe/): AIR's trait member order is NOT the
// declaration order AND is not stable across builds. Evidence: declaring the same
// four members in reverse yields the SAME order (so it is determined by the member
// name set, not by declaration); three repeated runs of one SWF agree; but adding
// three unrelated classes to the app changed the order of an untouched class
// ("Mix" went n1 u1 s1 o1 s2 i2 i1 b1 -> o1 n1 s1 u1 i2 b1 i1 s2), and rebuilding
// the original source restored it. That is an artifact of AVM2's internal trait
// table, not a semantic rule, so there is nothing to align to -- and AMF interop
// does not depend on it, because the traits carry the member names. We therefore
// pin OUR rule: members are written in declaration order, deterministically.
class Quad {
	public var a:int;
	public var b:String;
	public var c:Boolean;
	public var d:Number;
	public function Quad() {}
}
registerClassAlias("Quad", Quad);

var orderBa:ByteArray = new ByteArray();
orderBa.writeObject(new Quad());
var orderHex:String = "";
var saveOrderPos:int = orderBa.position;
orderBa.position = 0;
for (var oi:int = 0; oi < orderBa.length; oi++) {
	var ob:int = orderBa.readUnsignedByte();
	var oh:String = ob.toString(16);
	if (oh.length < 2) oh = "0" + oh;
	orderHex += oh + " ";
}
orderBa.position = saveOrderPos;
check(orderHex.indexOf("03 61 03 62 03 63 03 64") >= 0,
	"AMF3 writes the trait members in declaration order (a,b,c,d), got " + orderHex);

var quadIn:Quad = new Quad();
quadIn.a = 7;
quadIn.b = "s";
quadIn.c = true;
quadIn.d = 2.5;
var quadBa:ByteArray = new ByteArray();
quadBa.writeObject(quadIn);
quadBa.position = 0;
var quadOut:* = quadBa.readObject();
check(quadOut.a == 7 && quadOut.b == "s" && quadOut.c == true && quadOut.d == 2.5,
	"a Quad round-trips through AMF3 (order-independent on the read side)");

trace("stage94e cast / reflection / with fidelity: all checks passed");