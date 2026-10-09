// flash.utils.Proxy / the flash_proxy namespace (stage 94a).
//
// Reference behaviour (verified against AIR 51.4.1 via mxmlc + adl; probe sources
// and raw transcripts in ../../doc? -> temp/proxyprobe/, see TODO stage 94a):
// A `dynamic class X extends flash.utils.Proxy` intercepts every DYNAMIC operation
// through ten `flash_proxy` methods instead of the `_dyn` slot table:
//   p.foo            -> getProperty("foo")
//   p.foo = v        -> setProperty("foo", v)
//   delete p.foo     -> deleteProperty("foo")
//   "foo" in p       -> hasProperty("foo")
//   p.m()            -> callProperty("m")            (dotted call)
//   p["m"](1)        -> getProperty("m") then invoke (TypeError #1006 if not a Function)
//   String(p)        -> callProperty("toString")
//   for (k in p)     -> nextNameIndex(0) -> 1, nextName(1), nextNameIndex(1) -> 2, ...
//   for each (v in p)-> same protocol but nextValue(i) instead of nextName(i)
//   p.@attr          -> getProperty("attr")          (isAttribute is never called)
//   p..foo           -> getDescendants("foo")        (`..` is not in this subset)
// REAL traits are not intercepted (a declared field/accessor/method wins), and the
// base Proxy methods exist only to throw the numbered Error of their operation:
// #2088 get, #2089 set, #2090 callProperty, #2091 has, #2092 delete, #2093
// getDescendants, #2105 nextNameIndex, #2106 nextName, #2107 nextValue.
// The ten interceptor methods live in the `flash_proxy` NAMESPACE, not the public
// one: `p.getProperty("x")` and `p["getProperty"]` are ordinary dynamic operations
// (callProperty / getProperty), never the trait itself.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

dynamic class AllProxy extends Proxy {
  public var log:String = "";
  flash_proxy override function getProperty(name:*):* { return "get:" + String(name); }
  flash_proxy override function setProperty(name:*, value:*):void { log += "set:" + String(name) + "=" + String(value) + ";"; }
  flash_proxy override function deleteProperty(name:*):Boolean { return true; }
  flash_proxy override function hasProperty(name:*):Boolean { return name == "yes"; }
  flash_proxy override function callProperty(name:*, ...rest):* { return "call:" + String(name) + "/" + rest.length; }
  flash_proxy override function getDescendants(name:*):* { return "desc:" + String(name); }
  flash_proxy override function nextNameIndex(index:int):int { return index < 2 ? index + 1 : 0; }
  flash_proxy override function nextName(index:int):String { return "n" + index; }
  flash_proxy override function nextValue(index:int):* { return "v" + index; }
  public function getLog():String { return log; }
}

// Only two of the ten overridden: every other operation must throw its own error.
dynamic class PartialProxy extends Proxy {
  flash_proxy override function getProperty(name:*):* { return "P:" + String(name); }
  flash_proxy override function setProperty(name:*, value:*):void { }
}

// No override at all: the base Proxy implementations throw.
dynamic class BareProxy extends Proxy {
}

// Real members must win over interception, including inherited Object methods.
dynamic class RealProxy extends Proxy {
  public var realField:int = 1;
  public function realMethod():String { return "REAL"; }
  public function get realGetter():int { return 7; }
  flash_proxy override function getProperty(name:*):* { return "GET:" + String(name); }
  flash_proxy override function setProperty(name:*, value:*):void { }
  flash_proxy override function hasProperty(name:*):Boolean { return false; }
  flash_proxy override function callProperty(name:*, ...rest):* { return "CALL:" + String(name); }
}

// The flash_proxy NAMESPACE is what wires an interceptor: a same-named method in
// the PUBLIC namespace is just an ordinary method (measured on adl: `p.foo` still
// hits the base Proxy and throws #2088, while `p.getProperty("x")` is a plain
// call), so the qualifier — not the name alone — decides.
dynamic class PublicNsProxy extends Proxy {
  public function getProperty(name:*):* { return "PUB:" + name; }
  public function nextNameIndex(index:int):int { return 0; }
}

function errId(fn:Function):int {
  try { fn(); } catch (e:Error) { return e.errorID; }
  return -1;
}

var p:AllProxy = new AllProxy();

// --- 1) the ten interceptor methods on a fully-overriding subclass ---
check(p.foo == "get:foo", "read routes to getProperty");
p.foo = 5;
check(p.getLog() == "set:foo=5;", "write routes to setProperty");
check(("yes" in p) == true, "'in' routes to hasProperty (true)");
check(("no" in p) == false, "'in' routes to hasProperty (false)");
check((delete p.foo) == true, "delete routes to deleteProperty");
check(p.m2() == "call:m2/0", "dotted call routes to callProperty");
check(p.m2(1, 2, 3) == "call:m2/3", "callProperty receives the rest array");
check(String(p) == "call:toString/0", "String() routes to callProperty(\"toString\")");
check(p["m2"] == "get:m2", "bracket read routes to getProperty");
check(p.@attr == "get:attr", "E4X @ routes to getProperty");

// --- 2) enumeration protocol ---
var keys:String = "";
for (var k:String in p) { keys += k + ","; }
check(keys == "n1,n2,", "for-in uses nextNameIndex/nextName, got: " + keys);
var vals:String = "";
for each (var v:* in p) { vals += String(v) + ","; }
check(vals == "v1,v2,", "for-each uses nextNameIndex/nextValue, got: " + vals);

// --- 3) the flash_proxy NAMESPACE is not the public one ---
check(p.getProperty("x") == "call:getProperty/1", "public .getProperty() misses the trait -> callProperty");
check(p["getProperty"] == "get:getProperty", "public [\"getProperty\"] misses the trait -> getProperty");
check(p.isAttribute("x") == "call:isAttribute/1", "public .isAttribute() misses the trait -> callProperty");

// --- 4) a non-function callee is TypeError #1006, not a silent null ---
check(errId(function():* { return p["m2"](1, 2); }) == 1006, "bracket call of a non-function is #1006");

// --- 5) real traits win over interception ---
var rp:RealProxy = new RealProxy();
check(rp.realField == 1, "real field read is not intercepted");
rp.realField = 9;
check(rp.realField == 9, "real field write is not intercepted");
check(rp.realMethod() == "REAL", "real method call is not intercepted");
check(rp.realGetter == 7, "real getter is not intercepted");
check(rp.other == "GET:other", "undeclared read still routes to getProperty");
check((rp is Proxy) == true, "a Proxy subclass is a Proxy");
check((rp is RealProxy) == true, "a Proxy subclass is itself");
check(rp.hasOwnProperty("realField") == true, "real field hasOwnProperty");
check(rp.hasOwnProperty("other") == false, "proxied name hasOwnProperty follows hasProperty");

// --- 6) unoverridden operations throw the numbered Error of that operation ---
var q:PartialProxy = new PartialProxy();
check(q.foo == "P:foo", "partial override: getProperty works");
check(errId(function():* { return delete q.foo; }) == 2092, "partial delete -> #2092");
check(errId(function():* { return "foo" in q; }) == 2091, "partial 'in' -> #2091");
check(errId(function():* { for (var k2:String in q) { } return 0; }) == 2105, "partial for-in -> #2105");
check(errId(function():* { for each (var v2:* in q) { } return 0; }) == 2105, "partial for-each -> #2105");

var b:BareProxy = new BareProxy();
check(errId(function():* { return b.foo; }) == 2088, "bare read -> #2088");
check(errId(function():* { b.foo = 7; return 0; }) == 2089, "bare write -> #2089");
check(errId(function():* { return delete b.foo; }) == 2092, "bare delete -> #2092");
check(errId(function():* { return "foo" in b; }) == 2091, "bare 'in' -> #2091");
check(errId(function():* { return b.m2(); }) == 2090, "bare call -> #2090");
check(errId(function():* { for (var k3:String in b) { } return 0; }) == 2105, "bare for-in -> #2105");
check(errId(function():* { return b["getProperty"]; }) == 2088, "bare [\"getProperty\"] -> getProperty's #2088");

// --- 7) a public-namespace same-named method is NOT an interceptor ---
var pn:PublicNsProxy = new PublicNsProxy();
check(pn.getProperty("x") == "PUB:x", "public getProperty is an ordinary method");
check(typeof(pn["getProperty"]) == "function", "public getProperty is retrievable as a real trait");
check(errId(function():* { return pn.foo; }) == 2088, "public-ns getProperty does not intercept -> base #2088");
check(errId(function():* { for (var k4:String in pn) { } return 0; }) == 2105, "public-ns nextNameIndex does not intercept -> base #2105");

trace("proxy: all checks passed");