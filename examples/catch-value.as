// Exception values keep their identity: `catch (e:*)` (and the untyped
// `catch (e)`) bind the THROWN VALUE unchanged, not a synthesized Error.
//
// AS3's `throw` accepts any value -- string, number, Boolean, object, null --
// and a dynamic catch clause observes it back with its real type (`e is String`
// is true for a thrown string). A clause with a named type only matches values
// that are instances of that type, so an Error clause does NOT catch a thrown
// string (measured on adl 51.4.1, temp/qfix/catchsem.body.as).
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Marker {
  public var tag:String;
  public function Marker(t:String) { this.tag = t; }
}

class Marker2 extends Marker {
  public function Marker2() { super("m2"); }
}

function run():void {
  // A dynamic catch preserves a thrown string.
  var v1:* = null;
  try { throw "s"; } catch (e:*) { v1 = e; }
  check(v1 is String, "throw string -> e is String");
  check(v1 == "s", "throw string -> value preserved");

  // ... a thrown number, Boolean and object.
  var v2:* = null;
  try { throw 42; } catch (e:*) { v2 = e; }
  check(v2 is int, "throw 42 -> e is int");
  check((v2 as Number) == 42, "throw 42 -> value preserved");

  var v3:* = null;
  try { throw true; } catch (e:*) { v3 = e; }
  check(v3 is Boolean, "throw true -> e is Boolean");
  check(v3 == true, "throw true -> value preserved");

  var v4:Marker = null;
  try { throw new Marker2(); } catch (e:*) { v4 = e as Marker; }
  check(v4 != null && v4.tag == "m2", "throw object -> identity + subtype preserved");

  // `throw null` is a real thrown value, distinct from "no exception".
  var v5:Boolean = false;
  try { throw null; } catch (e:*) { v5 = (e == null); }
  check(v5, "throw null -> e == null");

  // A named clause only matches its own type: an Error clause must NOT intercept
  // a thrown string, so the dynamic clause after it is the one that runs.
  var hit:String = "";
  try { throw "x"; } catch (e:Error) { hit = "err"; } catch (e:*) { hit = "any"; }
  check(hit == "any", "Error clause does not catch a thrown string");

  // A String clause DOES catch a thrown string.
  var hit2:String = "";
  try { throw "y"; } catch (e:String) { hit2 = "str:" + e; } catch (e:*) { hit2 = "any"; }
  check(hit2 == "str:y", "String clause catches a thrown string");

  // An Error thrown normally is still caught by both an Error clause and a
  // dynamic clause; a subclass is caught by its base.
  var hit3:String = "";
  try { throw new Marker2(); } catch (e:Marker2) { hit3 = "m2"; } catch (e:*) { hit3 = "any"; }
  check(hit3 == "m2", "subclass clause matches");

  var msg:String = "";
  try { throw new Error("boom"); } catch (e:*) { msg = e.message; }
  check(msg == "boom", "Error value preserved through dynamic catch");

  var objHit:Boolean = false;
  try { throw new Error("z"); } catch (e:Object) { objHit = (e != null); }
  check(objHit, "Object clause catches an Error");

  // An untyped catch is dynamic too.
  var noType:String = "";
  try { throw "nt"; } catch (e) { noType = e; }
  check(noType == "nt", "untyped catch is dynamic");

  // Re-throwing from an inner dynamic catch preserves the value for the outer.
  var outer:String = "";
  try {
    try { throw "deep"; } catch (e:*) { throw e; }
  } catch (e:*) { outer = e; }
  check(outer == "deep", "rethrow preserves value");

  trace("catch-value: all checks passed");
}

run();
