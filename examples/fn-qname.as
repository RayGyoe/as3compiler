// Stage 327: the CLASS HALF of #1063's qname.
//
// AIR names the class that DECLARES the method actually reached through the
// receiver's RUNTIME class -- not the static type at the call site. Measured on
// adl 51.4.1 (temp/qname/, 18 forms; the reference run is adl-out.txt):
//
//   var c:C = new C()      C extends A, m declared only in A   -> A/m
//   var a:A = new B()      B overrides m                       -> B/m
//   var b:B = new B()      B declares the override             -> B/m
//   var w:W = new W()      W implements IFoo                   -> W/n
//   var i:IFoo = new W()   interface-typed reference           -> W/n   (not IFoo/n)
//   var io:InteractiveObject = new Sprite(); io.dispatchEvent  -> flash.events::EventDispatcher/dispatchEvent
//     (Sprite does not declare it; the nearest ancestor that does is EventDispatcher)
//   var dyn:* = new W(); dyn.n                                 -> W/n
//
// We used to print the STATIC type (`IFoo/n`, `InteractiveObject/dispatchEvent`),
// so the qname was wrong for every inherited/interface member taken as a value.
// The runtime walk is in as_method_owner_fqn (emitted with as_fn_arity_error).
//
// Two forms stay deliberately different, both measured:
//   * an anonymous closure: AIR prints `Function/Main.as$0:anonymous`, `$2` and
//     `$3` for the 1st/2nd/3rd closure -- the number is an AVM2 METHOD INDEX per
//     file (not a closure counter: `$1` belonged to a named sibling function), so
//     it is unreproducible by construction. We print `Function/anonymous`.
//   * an ANONYMOUS instance of the same construct prints "Function/anonymous"
//     above; a NESTED NAMED function is reproducible (`Function/inner`) and is
//     asserted below.
//   * a package-level function value: `mxmlc` rejects the expression outright
//     ("Access of possibly undefined property helper"), so AIR's form for it
//     cannot be measured and we keep `Function/<name>`.
import flash.display.InteractiveObject;
import flash.display.Sprite;
import flash.events.EventDispatcher;

class QA {
  public function m(a:int):void { }
}
class QB extends QA {
  override public function m(a:int):void { }
}
class QC extends QA {
}
interface QIFoo { function n(a:int):void; }
class QW implements QIFoo {
  public function n(a:int):void { }
}

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function qnameOf(f:Function):String {
  try { f(); return "<no throw>"; } catch (e:Error) { return e.message; }
}

function expectQ(actual:String, want:String, label:String):void {
  check(actual == want, label + ": want \"" + want + "\", got \"" + actual + "\"");
}

function run():void {
  // ① the declaring class is found by walking the RUNTIME class's chain.
  var qb:QB = new QB();
  expectQ(qnameOf(qb.m), "Error #1063: Argument count mismatch on QB/m(). Expected 1, got 0.",
    "an override declared in the runtime class names that class");

  var qc:QC = new QC();
  expectQ(qnameOf(qc.m), "Error #1063: Argument count mismatch on QA/m(). Expected 1, got 0.",
    "an inherited implementation names the class that DECLARES it, not the static type");

  var qa:QA = new QB();
  expectQ(qnameOf(qa.m), "Error #1063: Argument count mismatch on QB/m(). Expected 1, got 0.",
    "a base-typed reference to an override names the override's class");

  // ② interface receivers name the IMPLEMENTING class.
  var qw:QW = new QW();
  expectQ(qnameOf(qw.n), "Error #1063: Argument count mismatch on QW/n(). Expected 1, got 0.",
    "a class-typed interface implementor names itself");

  var qi:QIFoo = new QW();
  expectQ(qnameOf(qi.n), "Error #1063: Argument count mismatch on QW/n(). Expected 1, got 0.",
    "an interface-typed reference names the implementor, not the interface");

  // ③ a built-in member inherited several levels down names its declaring class.
  var io:InteractiveObject = new Sprite();
  expectQ(qnameOf(io.dispatchEvent),
    "Error #1063: Argument count mismatch on flash.events::EventDispatcher/dispatchEvent(). Expected 1, got 0.",
    "an inherited built-in member names the built-in class that declares it");
  var sp:Sprite = new Sprite();
  expectQ(qnameOf(sp.dispatchEvent),
    "Error #1063: Argument count mismatch on flash.events::EventDispatcher/dispatchEvent(). Expected 1, got 0.",
    "the same holds when only the runtime class is known");
  var ed:EventDispatcher = new EventDispatcher();
  expectQ(qnameOf(ed.dispatchEvent),
    "Error #1063: Argument count mismatch on flash.events::EventDispatcher/dispatchEvent(). Expected 1, got 0.",
    "and when the static type is the declaring class itself");

  // ④ a dynamic (`*`) receiver keeps the class that owns the reached method.
  var dyn:* = new QW();
  expectQ(qnameOf(dyn.n), "Error #1063: Argument count mismatch on QW/n(). Expected 1, got 0.",
    "a *-typed receiver names the runtime class");

  // ⑤ the two forms that stay deliberately different (see the header).
  var anon:Function = function(x:int):void { };
  expectQ(qnameOf(anon), "Error #1063: Argument count mismatch on Function/anonymous(). Expected 1, got 0.",
    "an anonymous closure has no reproducible AVM2 method index");

  function tf(x:int):void { }
  expectQ(qnameOf(tf), "Error #1063: Argument count mismatch on Function/tf(). Expected 1, got 0.",
    "a nested named function keeps its AS3 name (measured: AIR prints Function/inner)");

  trace("fn-qname: OK");
}

run();