// member-suffix-clash.as — members whose AS3 name collides with a symbol the
// emitter plants for EVERY class (Owner_cls / Owner_vt / Owner_ctor / Owner_props /
// Owner_amf_members / Owner_methods / Owner_cinit / ...). Those C names would be a
// redefinition (measured: `function cls()` and `static var amf_members` failed to
// compile). The member's C name gets a trailing underscore; the AS3-visible name
// (props table / AMF / for-in / reflection) is unchanged.
//
// Static methods (Owner_m_static), accessors (Owner_get_m / Owner_set_m) and
// instance fields (struct members) never collide, so they keep their plain names.
//
// Compile: as-aot examples/member-suffix-clash.as --run

class Weird {
  // Instance methods colliding with emitter-planted symbols.
  function cls():int { return 1; }
  function vt():int { return 2; }
  function ctor():int { return 3; }
  function cinit():int { return 7; }
  function getters():int { return 8; }
  function setters():int { return 9; }
  // Static fields colliding with emitter-planted symbols (kept distinct from the
  // method names above: a same-named instance method + static field is a separate,
  // pre-existing collision that is NOT this item's subject).
  static var props:int = 44;
  static var amf_members:int = 42;
  static var methods:int = 43;
}

function check(actual:int, expected:int, label:String):void {
  if (actual !== expected) throw new Error("FAIL " + label + ": got " + actual + " want " + expected);
}

var w:Weird = new Weird();
check(w.cls(), 1, "instance method cls");
check(w.vt(), 2, "instance method vt");
check(w.ctor(), 3, "instance method ctor");
check(w.cinit(), 7, "instance method cinit");
check(w.getters(), 8, "instance method getters");
check(w.setters(), 9, "instance method setters");

check(Weird.props, 44, "static field props");
check(Weird.amf_members, 42, "static field amf_members");
check(Weird.methods, 43, "static field methods");

// A renamed member still dispatches through the dynamic path (as_dyn_call) and as
// a function value — the C symbol changed, the AS3 name did not.
var dyn:Object = w;
check(dyn["cls"](), 1, "dynamic call cls");
check(dyn["getters"](), 8, "dynamic call getters");
var fn:Function = w.ctor;
check(fn(), 3, "function value ctor");

// Write-then-read a renamed static field.
Weird.methods = 100;
check(Weird.methods, 100, "static field methods after write");

trace("member-suffix-clash: all ok");
