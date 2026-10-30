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
//   p..foo           -> getDescendants("foo")        (Package H-2)
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

// Logs the enumeration protocol calls so a '*' / Object slot can be checked
// against the inline protocol a statically typed receiver emits.
dynamic class SeqProxy extends Proxy {
  public var log:String = "";
  flash_proxy override function nextNameIndex(index:int):int { log += "ni" + index + ";"; return index < 3 ? index + 1 : 0; }
  flash_proxy override function nextName(index:int):String { log += "nn" + index + ";"; return "k" + index; }
  flash_proxy override function nextValue(index:int):* { log += "nv" + index + ";"; return "v" + index; }
}

// A subclass that overrides ONLY nextNameIndex: for-in then needs nextName and
// for-each needs nextValue, so each fails with its own error id (measured on
// adl 51.4.1, temp/proxyany D3/D4: #2106 and #2107).
dynamic class HalfProxy extends Proxy {
  flash_proxy override function nextNameIndex(index:int):int { return index < 1 ? index + 1 : 0; }
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

// --- 8) a '*' / Object slot follows the VALUE's class, not the declared one ---
// AIR decides at run time ('vp is Proxy'), so a receiver declared '*' or Object
// still runs the interceptor protocol (measured on adl 51.4.1, temp/proxyany
// A1..A5+B1..B4: identical names, values and call sequence for all three).
var sq:SeqProxy = new SeqProxy();
var star:* = sq;
var k5:String = "";
for (var kStar:String in star) { k5 += kStar + ","; }
check(k5 == "k1,k2,k3,", "for-in through a '*' receiver runs the proxy protocol, got: " + k5);
check(sq.log == "ni0;nn1;ni1;nn2;ni2;nn3;ni3;", "for-in '*' call sequence, got: " + sq.log);
sq.log = "";
var v5:String = "";
for each (var vStar:* in star) { v5 += String(vStar) + ","; }
check(v5 == "v1,v2,v3,", "for-each through a '*' receiver runs the proxy protocol, got: " + v5);
check(sq.log == "ni0;nv1;ni1;nv2;ni2;nv3;ni3;", "for-each '*' call sequence, got: " + sq.log);
sq.log = "";
var obStar:Object = sq;
var k6:String = "";
for (var kObj:String in obStar) { k6 += kObj + ","; }
check(k6 == "k1,k2,k3,", "for-in through an Object receiver runs the proxy protocol, got: " + k6);
sq.log = "";
var v6:String = "";
for each (var vObj:* in obStar) { v6 += String(vObj) + ","; }
check(v6 == "v1,v2,v3,", "for-each through an Object receiver runs the proxy protocol, got: " + v6);

// The runtime branch must not swallow the interception errors of a subclass that
// does not override the protocol: the '*' slot reaches the same #2105 / #2107.
var bareStar:* = new BareProxy();
check(errId(function():* { for (var k7:String in bareStar) { } return 0; }) == 2105, "'*' over an unoverriding proxy -> #2105");
check(errId(function():* { for each (var v7:* in bareStar) { } return 0; }) == 2105, "'*' for-each over an unoverriding proxy -> #2105");
var halfStar:* = new HalfProxy();
check(errId(function():* { for (var k7b:String in halfStar) { } return 0; }) == 2106, "'*' for-in over a nextNameIndex-only proxy -> #2106");
check(errId(function():* { for each (var v7b:* in halfStar) { } return 0; }) == 2107, "'*' for-each over a nextNameIndex-only proxy -> #2107");

// ... and it must not change what a NON-proxy value enumerates through '*':
// indices for an Array, the dynamic names for an object literal, nothing for a
// sealed instance (all measured on adl 51.4.1, temp/proxyany E1/E4).
var arrStar:* = ["x", "y"];
var k8:String = "";
for (var kArr:String in arrStar) { k8 += kArr + ","; }
check(k8 == "0,1,", "'*' over an Array still enumerates its indices, got: " + k8);
var litStar:* = { p: 1 };
var n0:int = 0;
for (var kLit:String in litStar) { n0++; }
check(n0 == 1, "'*' over an object literal still enumerates its own name");
class Holder { public var a:int = 1; }
var sealedStar:* = new Holder();
var n1:int = 0;
for (var kSeal:String in sealedStar) { n1++; }
check(n1 == 0, "'*' over a sealed instance enumerates nothing");

// --- 9) `..` routes to getDescendants (only XML/XMLList and Proxy accept it) ---
// Measured on adl 51.4.1 (temp/proxyany G1..G6 + H1..H6): `p..foo` calls the
// flash_proxy interceptor and `p..*` passes the LITERAL "*" (unlike the XML axis,
// which uses an empty name for the wildcard); a Proxy that does not override it
// throws base #2093; a String/Array/sealed instance/object literal raises
// TypeError #1016 at run time, a null receiver #1009.
check(p..foo == "desc:foo", "'..' routes to getDescendants");
check(p..* == "desc:*", "'..*' passes the literal '*' as the name");
var pAny:* = p;
check(pAny..bar == "desc:bar", "'..' through a '*' receiver routes to getDescendants");
var pObj:Object = p;
check(pObj..bar == "desc:bar", "'..' through an Object receiver routes to getDescendants");
var pBare:BareProxy = new BareProxy();
check(errId(function():* { return pBare..foo; }) == 2093, "bare proxy '..' -> #2093");
var notXml:* = "ab";
check(errId(function():* { return notXml..foo; }) == 1016, "'..' on a String value -> #1016");
var notXml2:* = [1, 2];
check(errId(function():* { return notXml2..foo; }) == 1016, "'..' on an Array value -> #1016");
var xv:* = <a><foo>7</foo></a>;
check(("" + xv..foo) == "7", "'..' on an XML value in a '*' slot still walks the XML axis");


// --- 10) `with` over an Array / Dictionary / interface / String / Vector ---
// Measured on adl 51.4.1 (temp/proxyany MainW): the with object resolves the
// receiver's own members first -- an Array answers length/indices/method names,
// a Dictionary its keys, an interface the concrete instance's traits, a String its
// length and method names, a Vector its length/fixed/methods -- and any name the
// receiver does not have falls through to the enclosing scope. A null receiver is
// the usual #1009.
// The bodies below only read and assign: a CALL with a side-effecting argument
// inside a dynamically resolved `with` is rejected by design (the callee test
// duplicates the call site across both branches), so the checks stay outside.
var wLexLength:String = "LEX-LEN";
var wLexFoo:String = "LEX-FOO";
var wLexK:String = "LEX-K";
var wArr:Array = [10, 20];
var w1:String = "";
with (wArr) { w1 += "len=" + length; w1 += " lex=" + wLexLength; }
check(w1 == "len=2 lex=LEX-LEN", "with(Array) resolves length and falls through, got: " + w1);
with (wArr) { push(30); }
check(wArr.length == 3, "with(Array) dispatches a method to the receiver");
check(("push" in wArr) == true, "an Array's methods are members for 'in'");
var wDict:Dictionary = new Dictionary();
wDict["k"] = 7;
var w2:String = "";
with (wDict) { w2 += "k=" + k; w2 += " lex=" + wLexK; }
check(w2 == "k=7 lex=LEX-K", "with(Dictionary) resolves a key and falls through, got: " + w2);
var wStr:String = "abc";
var w3:String = "";
with (wStr) { w3 += "len=" + length; w3 += " ca=" + charAt(1); w3 += " foo=" + wLexFoo; }
check(w3 == "len=3 ca=b foo=LEX-FOO", "with(String) resolves length/method and falls through, got: " + w3);
var wVec:Vector.<int> = new Vector.<int>();
wVec.push(5);
with (wVec) { push(6); }
check(wVec.length == 2, "with(Vector) resolves length and dispatches push");
check(errId(function():* { var n:Array = null; with (n) { return wLexFoo; } }) == 1009, "with(null Array) -> #1009");
interface IWTag { function wTag():String; }
class WThing implements IWTag {
  public var tag:String = "T";
  public function wTag():String { return "PONG"; }
}
var wIface:IWTag = new WThing();
var w4:String = "";
with (wIface) { w4 += "tag=" + tag; w4 += " ping=" + wTag(); }
check(w4 == "tag=T ping=PONG", "with(interface) sees the concrete instance's traits, got: " + w4);

// --- 11) `in` on a dynamically typed receiver ---
// Measured on adl 51.4.1 (temp/proxyany MainI/MainI2/MainI3/MainI4): the answer is
// membership of the value's RUNTIME class -- a String answers length and its
// method names (never a character index), an Array also answers its method names,
// null is #1009, undefined is #1010. A boxed String used to segfault here, because
// the trait walk read the string body as an object.
var inStr:* = "abc";
check(("length" in inStr) == true, "'in' on a boxed String finds length");
check(("charAt" in inStr) == true, "'in' on a boxed String finds a method name");
check(("0" in inStr) == false, "'in' on a boxed String: a character index is not a member");
var inStrTyped:String = "abc";
check(("length" in inStrTyped) == true, "'in' on a statically typed String finds length");
check(("substring" in inStrTyped) == true, "'in' on a statically typed String finds a method name");
var inArr:* = [1, 2];
check(("push" in inArr) == true, "'in' on a boxed Array finds a method name");
check(("2" in inArr) == false, "'in' on a boxed Array: an out-of-range index is not a member");
check(errId(function():* { var nu:* = null; return "x" in nu; }) == 1009, "'in' on null -> #1009");
check(errId(function():* { var un:* = undefined; return "x" in un; }) == 1010, "'in' on undefined -> #1010");

// --- 12) a closure created inside a `with` body captures the OBJECT ---
// Measured on adl 51.4.1 (temp/proxyany/wcap + wcap/Main2): the closure keeps the
// with object in its scope chain, so the names it serves are decided at CALL time —
// a later write to the object is visible, an assignment inside the closure lands on
// the object, nested with blocks are all captured with the inner one winning, the
// reference survives the block exit, and a variable declared in the body stays an
// ordinary function local.
var capLex:String = "LEX";
var capObj:Object = { x: "OBJ-X" };
var capF:Function;
with (capObj) { capF = function():* { return x + "/" + capLex; }; }
check(capF() == "OBJ-X/LEX", "a closure created in a with body resolves against the object, got: " + capF());
capObj.x = "OBJ-X2";
check(capF() == "OBJ-X2/LEX", "the captured with object is a reference, not a snapshot, got: " + capF());
var capSet:Function;
with (capObj) { capSet = function():void { x = "SET"; }; }
capSet();
check(capObj.x == "SET", "an assignment in the closure writes to the with object");
var capInner:Object = { y: "OBJ-Y" };
var capDeep:Object = { z: "OBJ-Z" };
var capNest:Function;
with (capInner) { with (capDeep) { capNest = function():* { return y + "/" + z; }; } }
check(capNest() == "OBJ-Y/OBJ-Z", "nested with blocks are both captured, got: " + capNest());
var capLocal:Function;
with (capObj) { var capBody:String = "LOC"; capLocal = function():* { return capBody; }; }
check(capLocal() == "LOC", "a variable declared in the with body stays a function local");
// A closed builtin receiver keeps its static member set inside the closure.
var capStr:String = "abc";
var capLen:Function;
with (capStr) { capLen = function():* { return length + ":" + charAt(2); }; }
check(capLen() == "3:c", "a String with receiver keeps its members inside the closure, got: " + capLen());
var capVec:Vector.<int> = new Vector.<int>();
capVec.push(4);
var capVecLen:Function;
with (capVec) { capVecLen = function():* { return length; }; }
check(capVecLen() == 1, "a Vector with receiver keeps its members inside the closure");
// Two sequential with blocks: each closure keeps its OWN object (the sibling merge
// must not hand one closure the other's receiver).
var capA:Object = { a: "A1" };
var capB:Object = { a: "A2" };
var capPA:Function;
var capQB:Function;
with (capA) { capPA = function():* { return a; }; }
with (capB) { capQB = function():* { return a; }; }
check(capPA() == "A1" && capQB() == "A2", "each closure keeps its own with object");
var capSibling:Function = function():* { return "S1"; };
var capSibling2:Function;
with (capA) { capSibling2 = function():* { return "S2:" + a; }; }
check(capSibling() == "S1" && capSibling2() == "S2:A1", "a sibling closure outside the with is unaffected");

trace("proxy: all checks passed");