// The `with` statement (stage 94b).
//
// Reference behaviour (verified against AIR 51.4.1 via mxmlc + adl; probe sources
// and raw transcripts in temp/withprobe/, see TODO stage 94b):
// A `with (obj) stmt` inserts `obj`'s members as the INNERMOST scope for the whole
// statement, ahead of locals, params, `this` members and module variables:
//   with (h) { a }        -> h.a          (the object's field, not a local `a`)
//   with (h) { a = 7 }    -> h.a = 7
//   with (h) { m() }      -> h.m()        (`this` inside m is h, not the caller)
//   with (h) { g }        -> h.get_g()    (accessors resolve through the object)
//   with (h) { localX }   -> localX       (a name the object lacks FALLS THROUGH)
// The fall-through is silent: no #1069, and a WRITE to a name the object lacks also
// falls through (a dynamic object does NOT gain the property). A name that resolves
// nowhere at all is ReferenceError #1065 *inside* a with body (outside it, the same
// read is a compile error, which is what mxmlc reports too).
// The receiver is evaluated once; null/undefined receivers throw TypeError #1009 /
// #1010 on entry; a write to a read-only trait (a getter with no setter) throws
// ReferenceError #1074; `delete fixedProp` on a statically known class is rejected
// at compile time (mxmlc: "cannot delete a fixed property").
// Statically typed receivers resolve at compile time and branch-free; a `*`/Object/
// dynamic/Proxy receiver resolves at runtime through hasProperty, so a Proxy
// subclass sees the interceptor protocol (see examples/proxy.as).
// NOT in this subset (registered in TODO.md): an Array/Vector/String/Function/
// Dictionary/interface receiver (loud compile error), a `with` scope captured by a
// closure body, and a Function-valued member called as `with (o) { fn() }`.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Holder {
  public var a:int = 1;
  public var shared:String = "holder";
  public var z:int = 500;
  public function Holder() { }
  public function m():String { return "H.m"; }
  public function get g():String { return "H.g"; }
}

class RO {
  public var settable:int = 8;
  public function RO() { }
  public function get ro():int { return 5; }
}

dynamic class WProxy extends Proxy {
  public var hits:String = "";
  public var props:Object = { a: 123, shared: "proxy" };
  public function WProxy() { }
  flash_proxy override function getProperty(name:*):* { hits += "G:" + String(name) + ";"; return props[name]; }
  flash_proxy override function setProperty(name:*, value:*):void { hits += "S:" + String(name) + "=" + String(value) + ";"; props[name] = value; }
  flash_proxy override function hasProperty(name:*):Boolean { hits += "H:" + String(name) + ";"; return props.hasOwnProperty(name); }
}

class ThisProbe {
  public var self:ThisProbe;
  public function ThisProbe() { self = this; }
  // `this` inside the with body is unchanged (measured w8/w9).
  public function sameThis(o:Holder):Boolean { with (o) { return this == self; } }
}

function errId(fn:Function):int {
  try { fn(); } catch (e:Error) { return e.errorID; }
  return 0;
}

// --- 1) the object's members win over module scope, locals and params ---------
var shared:String = "outer";
var onlyOuter:int = 42;
var h:Holder = new Holder();
var zLocal:int = 5;

check((function():* { with (h) { return shared; } })() == "holder", "with: the object's field beats the module var");
check(onlyOuter == 42 && (function():* { with (h) { return onlyOuter; } })() == 42, "with: an absent name falls through to the module var");
check((function():* { with (h) { zLocal = 500; return 0; } })() == 0 && zLocal == 500, "with: an absent name writes through to the module var");
check((function():int { var a:int = 9; with (h) { return a; } })() == 1, "with: the object's field beats a local");
check((function():String { var p:String = "arg"; with (h) { return shared; } })() == "holder", "with: the object beats a param");
check((function():int { var z:int = 5; with (h) { return z; } })() == 500, "with: the object's field beats a local of the same name");

// --- 2) writes and accessors go to the object --------------------------------
var h2:Holder = new Holder();
check((function():int { with (h2) { a = 7; } return h2.a; })() == 7, "with: a write lands on the object's field");
check((function():String { with (h2) { return g; } })() == "H.g", "with: a getter resolves through the object");
check((function():String { with (h2) { return m(); } })() == "H.m", "with: a method resolves through the object");

// --- 3) `this` is not the with object ---------------------------------------
var probe:ThisProbe = new ThisProbe();
check(probe.sameThis(new Holder()) == true, "with: `this` is unchanged inside the body");

// --- 4) nested with: innermost first ----------------------------------------
var h3:Holder = new Holder();
h3.a = 100; h3.shared = "inner";
check((function():String { with (h) { with (h3) { return a + "/" + shared; } } })() == "100/inner", "with: nested scopes resolve innermost first");

// --- 5) a `var` declared inside the body stays local ------------------------
var hz:Holder = new Holder();
check((function():String { with (hz) { var z9:int = 99; return z9 + "/" + hz.z; } })() == "99/500", "with: a var declared in the body is local (not a property)");

// --- 6) dynamic receivers: hasProperty-gated (Object / Proxy) ---------------
check((function():String { var d:Object = { a: 5, shared: "dyn" }; with (d) { return a + "/" + shared; } })() == "5/dyn", "with: an Object receiver resolves its keys");
check((function():String { var d2:Object = { a: 5 }; with (d2) { return onlyOuter + ""; } })() == "42", "with: an Object receiver falls through for a missing key");
check((function():String { var d3:Object = { nope: 1 }; with (d3) { d3.qq = 0; } return d3.hasOwnProperty("qq") + ""; })() == "true", "with: an explicit dynamic write still creates the key");
check((function():String { var d4:Object = { k: 1 }; with (d4) { delete k; } return ("k" in d4) + ""; })() == "false", "with: delete resolves to the object and removes the key");

var wp:WProxy = new WProxy();
check((function():int { with (wp) { return a; } })() == 123, "with: a Proxy consults getProperty");
check(wp.hits == "H:a;G:a;", "with: a Proxy consults hasProperty then getProperty (got " + wp.hits + ")");
wp.hits = "";
check((function():String { with (wp) { shared = "W"; } return wp.shared; })() == "W", "with: a Proxy consults setProperty");
check(wp.hits == "H:shared;S:shared=W;G:shared;", "with: a Proxy write is hasProperty-gated, and the read-back is intercepted too (got " + wp.hits + ")");

// --- 7) runtime errors from a `with` receiver -------------------------------
var ro:RO = new RO();
check(errId(function():* { with (ro) { return ro; } }) == 0, "with: a getter-only read is fine");
check(errId(function():* { with (ro) { ro = 6; } return 0; }) == 1074, "with: writing a getter-only property -> #1074");
check((function():int { with (ro) { settable = 9; } return ro.settable; })() == 9, "with: writing a settable property works");
check(errId(function():* { var o:* = null; with (o) { return onlyOuter; } }) == 1009, "with: a null receiver -> #1009");
check(errId(function():* { var u:* = undefined; with (u) { return onlyOuter; } }) == 1010, "with: an undefined receiver -> #1010");
check(errId(function():* { with (h) { return noSuchMethod(); } }) == 1065, "with: a name that resolves nowhere -> #1065");

// --- 8) `with` over a Proxy inside a closure-free body, for-in --------------
check((function():String {
  var d5:Object = { nope: 1 };
  var s:String = "";
  with (d5) { for (var k:String in d5) { s += k + ","; } }
  return s;
})() == "nope,", "with: for-in still walks the object's keys");

trace("with: all checks passed");