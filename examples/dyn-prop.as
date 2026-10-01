// Dynamic property semantics on the two sides of AS3's sealed/dynamic divide.
//
// Reference behaviour (verified against AIR 51.4.1 via mxmlc + adl):
//   sealed class instance  -> write new prop : ReferenceError #1056 (it used to
//                                              be a silent no-op)
//                          -> read missing    : ReferenceError #1069 (it used to
//                                              be a silent null)
//   dynamic (Object/Array/MovieClip/URLVariables) -> write ok, missing read
//                                              gives a default (null/undefined)
// Sprite/Shape/TextField/EventDispatcher/Matrix/ByteArray/URLLoader are sealed;
// only MovieClip (among the display classes) is dynamic.
// An AS3 Array is dynamic, and a NON-index key is an ordinary named property:
//   a.bar = 8  ->  a.bar == 8, a.length == 3, a[0] == 1
// It used to write a[0] via strtol("bar") == 0, corrupting the first element.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Sealed {
  public var x:int = 1;
  public function Sealed() { }
}
class Sealed2 {
  public var x:int = 1;
  public function Sealed2() { }
}
dynamic class Dyn {
  public var x:int = 7;
  public function Dyn() { }
}
class DynSub extends Dyn { }
class McSub extends MovieClip { }

// --- 1) sealed class: creating a property throws Error #1056 ---
var s:* = new Sealed();
var threw:Boolean = false;
var msg:String = "";
try { s.unknown = 5; } catch (e:Error) { threw = true; msg = e.message; }
check(threw, "sealed write must throw");
check(msg.indexOf("1056") >= 0, "message should be #1056, got: " + msg);
check(msg.indexOf("unknown") >= 0, "message should name the property, got: " + msg);
check(msg.indexOf("Sealed") >= 0, "message should name the class, got: " + msg);

// the [] form behaves identically
var s2:* = new Sealed();
var threw2:Boolean = false;
try { s2["unknown"] = 5; } catch (e2:Error) { threw2 = true; }
check(threw2, "sealed index-write must throw");

// --- 2) sealed class: reading a missing property throws Error #1069 ---
var s3:* = new Sealed();
var threw3:Boolean = false;
var msg3:String = "";
try { var v:* = s3.unknown; } catch (e3:Error) { threw3 = true; msg3 = e3.message; }
check(threw3, "sealed read must throw");
check(msg3.indexOf("1069") >= 0, "message should be #1069, got: " + msg3);
check(s3.x == 1, "declared fields remain readable");

// --- 3) Array named properties must not touch the elements ---
var a:Array = [1, 2, 3];
a.bar = 8;
check(a.bar == 8, "named property value, got " + a.bar);
check(a.length == 3, "length must not change, got " + a.length);
check(a[0] == 1, "element 0 must not change, got " + a[0]);
check(a[2] == 3, "element 2 must not change, got " + a[2]);

var d:* = [1, 2, 3];
d.bar = 8;
check(d.bar == 8, "dyn-receiver named property, got " + d.bar);
check(d.length == 3, "dyn-receiver length must not change, got " + d.length);
check(d[0] == 1, "dyn-receiver element 0 must not change, got " + d[0]);

// canonical index keys only: "01"/"-1" are named properties, not elements
var e:* = [7, 8];
check(e["1"] == 8, "numeric-string index reads the element, got " + e["1"]);
check(e["0"] == 7, "index 0");
check(e["01"] != 7, "\"01\" is not a canonical index");
check(e["-1"] != 8, "\"-1\" is not a canonical index");
check(e.length == 2, "non-canonical keys must not grow the array, got " + e.length);

// --- 4) genuinely dynamic receivers keep working ---
var o:* = {};
o.k = 1;
check(o.k == 1, "object literal dynamic write");
var u:* = new URLVariables();
u.foo = "bar";
check(u.foo == "bar", "URLVariables is a dynamic class");

// --- 5) built-in classes: sealed vs dynamic matches AIR exactly ---
// adl ground truth: Sprite/Shape/TextField/EventDispatcher/Matrix/ByteArray/URLLoader
// are sealed; only MovieClip / URLVariables / Object / Array / Dictionary are dynamic.
var sp:* = new Sprite();
var threw4:Boolean = false;
try { sp.custom = 1; } catch (e4:Error) { threw4 = true; }
check(threw4, "Sprite is sealed in AS3");

var mc:MovieClip = new MovieClip();
mc.foo = 1;
check(mc.foo == 1, "MovieClip is dynamic: mc.foo == 1, got " + mc.foo);
check(mc.currentFrame == 0, "MovieClip still reports its own fields");
var mcd:* = mc;
mcd.bar = 2;
check(mcd.bar == 2, "MovieClip dynamic write through a * receiver");

// --- 6) user `dynamic class`: declared, and INHERITED along the super chain ---
var u:Dyn = new Dyn();
u.foo = 1;
check(u.foo == 1, "dynamic class accepts an undeclared property");
check(u.x == 7, "declared fields still work on a dynamic class");
var usub:DynSub = new DynSub();
usub.foo = 2;
check(usub.foo == 2, "a subclass of a dynamic class is itself dynamic (AS3 rule)");
// A subclass of a dynamic BUILT-IN (MovieClip) is dynamic too.

var g:McSub = new McSub();
g.tag = "hi";
check(g.tag == "hi", "subclass of MovieClip inherits dynamic-ness");
check(g.currentFrame == 0, "...and still inherits MovieClip's fields");

// A sealed class must stay sealed even though it has a dynamic ancestor chain of one.
// (A *typed* sealed write is already a compile-time error; this checks the runtime path.)
var sealed2:* = new Sealed2();
var threw5:Boolean = false;
try { sealed2.nope = 1; } catch (e5:Error) { threw5 = true; }
check(threw5, "a plain class stays sealed (no dynamic ancestor)");

trace("dyn-prop: all assertions passed");