// Top-level `new <Object/any variable>()`: dynamic class instantiation from a
// module-level variable holding a Class value. The class and function scopes
// already resolved this (stage 111), but the MODULE scope's Object/any variables
// were missed, so `var o:Object = SomeClass; new o();` at top level reported
// `Codegen error: unknown class 'o'`. AIR constructs the class in every scope.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class DynWidget {
  public var tag:String = "w";
  public function DynWidget() { }
}

// Module-level Class slot and Object/any slot.
var k:Class = DynWidget;
var o:Object = k;
var anySlot:* = DynWidget;

var a:* = new k();
check(a is DynWidget, "top-level new <Class var>()");
check((a as DynWidget).tag == "w", "...carries the constructed instance");

var b:* = new o();
check(b is DynWidget, "top-level new <Object var>()");

var c:* = new anySlot();
check(c is DynWidget, "top-level new <any var>()");

// A non-Class value in the slot is AIR's TypeError #1007, not a silent crash.
var junk:Object = 42;
var e:int = 0;
try { new junk(); } catch (err:*) { e = err.errorID; }
check(e == 1007, "non-constructor operand throws #1007");

trace("top-dynnew: all checks passed");
