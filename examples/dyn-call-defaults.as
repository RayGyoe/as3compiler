// Stage 139b: a DYNAMIC call (a `*`-typed receiver, dispatched through
// as_dyn_call/as_any_call to the method-reflection thunk) applies the DECLARED
// DEFAULT of every omitted optional parameter, and AIR's argument-count check
// runs BEFORE the dispatch.
//
// Both halves were measured on adl 51.4.1 (temp/tkmeet-mac/dyn/adl.txt):
//   c.f(1)        -> 7        the omitted `b:int = 7` takes its default
//   c.f(1,2,3)    -> #1063    ArgumentError "Expected 1, got 3."
//   h.m(9)        -> #1063    a 0-parameter METHOD rejects any argument
//   d.g()         -> "def"    an omitted String default
//   r.r(5,1,2,3)  -> "5|3|1-2-3"   a rest parameter packs the trailing arguments
//   s.t()         -> #1063    "Expected 1, got 0." (required before a rest)
// NOTE the asymmetry with a Function VALUE: AIR builds a 0-parameter CLOSURE
// variadic, but a 0-parameter METHOD rejects any argument.
//
// Before the fix the thunk read `args[i]` unguarded, so every omitted optional
// argument was an OUT-OF-BOUNDS read of the caller's as_value[] -- and a NULL
// dereference when the call had no arguments at all (the array is passed as
// NULL). That is what crashed the real talkmed-meeting AIR app inside
// com.vsdevelop.air.data.SQLConnect's constructor:
//   Conn.addEventListener(SQLErrorEvent.ERROR, errorHandler)
// on a `public var Conn:*` receiver -> argc=2 for a 5-parameter method -> the
// thunk read args[2..4] off the caller's stack, one of them looked like an Array
// (tag 6) with a garbage pointer, and as_array_join died in strlen.
import flash.events.EventDispatcher;
import flash.events.Event;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// Run `f` and return the Error it threw, or null.
function caught(f:Function):Error {
  try { f(); return null; } catch (e:Error) { return e; }
}

class C {
  public function f(a:int, b:int = 7):int { return b; }
}
class H {
  public function m():int { return 5; }
}
class D {
  public function g(x:String = "def"):String { return x; }
}
class R {
  public function r(a:int = 0, ...rest):String { return a + "|" + rest.length + "|" + rest.join("-"); }
}
class S {
  public function t(a:int, ...rest):String { return a + "|" + rest.length; }
}

function run():void {
  var c:* = new C();
  check(c.f(1) == 7, "an omitted optional argument takes its declared default, got " + c.f(1));
  check(c.f(1, 2) == 2, "a supplied optional argument still wins, got " + c.f(1, 2));

  var few:Error = caught(function():void { c.f(); });
  check(few != null && few is ArgumentError, "too few arguments throws ArgumentError");
  check(few.errorID == 1063, "too few arguments is #1063, got " + few.errorID);
  check(few.message == "Error #1063: Argument count mismatch on C/f(). Expected 1, got 0.",
    "the #1063 text names the class, the method and the counts, got: " + few.message);

  var many:Error = caught(function():void { c.f(1, 2, 3); });
  check(many != null && many.errorID == 1063 && many.message == "Error #1063: Argument count mismatch on C/f(). Expected 1, got 3.",
    "too many arguments is #1063 with the same 'Expected' count, got: " + (many == null ? "no throw" : many.message));

  // A 0-parameter method rejects ANY argument (unlike a 0-parameter closure).
  var h:* = new H();
  check(h.m() == 5, "a 0-parameter method with no arguments runs, got " + h.m());
  var zero:Error = caught(function():void { h.m(9); });
  check(zero != null && zero.errorID == 1063 && zero.message == "Error #1063: Argument count mismatch on H/m(). Expected 0, got 1.",
    "a 0-parameter method rejects an argument, got: " + (zero == null ? "no throw" : zero.message));

  // An omitted String default (a wrong value here is visible, not merely numeric).
  var d:* = new D();
  check(d.g() == "def", "an omitted String optional argument takes its default, got [" + d.g() + "]");

  // A rest parameter packs every trailing argument, and req counts only the
  // parameters BEFORE it.
  var r:* = new R();
  check(r.r() == "0|0|", "a rest parameter is an empty Array when nothing trails, got " + r.r());
  check(r.r(5, 1, 2, 3) == "5|3|1-2-3", "a rest parameter packs the trailing arguments, got " + r.r(5, 1, 2, 3));
  var s:* = new S();
  check(s.t(1) == "1|0", "a rest parameter packs nothing when omitted, got " + s.t(1));
  check(s.t(1, 8, 9) == "1|2", "a rest parameter packs two arguments, got " + s.t(1, 8, 9));
  var sFew:Error = caught(function():void { s.t(); });
  check(sFew != null && sFew.errorID == 1063 && sFew.message == "Error #1063: Argument count mismatch on S/t(). Expected 1, got 0.",
    "a required parameter before a rest is still counted, got: " + (sFew == null ? "no throw" : sFew.message));

  // The exact shape that crashed the real app: a `*`-typed built-in receiver, 2
  // arguments, 3 optional parameters omitted.
  var disp:* = new EventDispatcher();
  disp.addEventListener("x", function(e:Event):void { });
  check(disp.hasEventListener("x") == true, "addEventListener with 3 omitted optionals registers the listener");
  var dispZero:Error = caught(function():void { disp.addEventListener(); });
  check(dispZero != null && dispZero.errorID == 1063, "addEventListener() with 0 arguments is #1063, got " + (dispZero == null ? "no throw" : dispZero.errorID));
  var dispMany:Error = caught(function():void { disp.addEventListener("x", function(e:Event):void { }, false, 0, false, 99); });
  check(dispMany != null && dispMany.errorID == 1063, "addEventListener with 6 arguments is #1063, got " + (dispMany == null ? "no throw" : dispMany.errorID));
}

run();
trace("dyn-call-defaults: ok");
