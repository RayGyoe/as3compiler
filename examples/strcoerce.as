// strcoerce.as — implicit Object -> String coercion (阶段一百一十二): the table AIR
// actually produces, pinned as a regression.
//
// The conversion is not the same question for every container, which is what
// made it silently wrong before:
//
//   1. "a" + x where x is a static-typed E      -> dispatches E.toString()
//   2. "a" + o where o is Object-typed (= x)    -> dispatches too (dynamic!)
//   3. "a" + arr[0] (any-typed array element)   -> dispatches too
//   4. String(x) / x + "b" / x.toString()       -> dispatches
//   5/6. an F that does NOT override toString() -> "[object F]" (the LOCAL name,
//        never the C identifier) — both when concatenated and when printed alone
//   7. a Dictionary value / an Array element    -> dispatches (they are values
//        stored as `any`, so they fall out of as_v_str_val, not out of a C cast)
//   8. String(null) -> "null"
//
// Measured with adl 51.4.1 (temp/strprobe/AdlScene.as writes out.txt through a
// FileStream; ours must print the identical 12 lines). Two bugs this caught:
// a static-typed concat used the C class name ("aaway3d_..."), and a dynamic one
// returned the tag name ("object") — the second is what broke away3d's AGAL
// assembly, because ShaderRegisterElement.toString() returning "vt0" is the
// entire mechanism by which the fragment source is built by concatenation.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function eq(got:String, want:String, msg:String):void {
  if (got != want) throw new Error("FAIL: " + msg + " — got '" + got + "', want '" + want + "'");
}

class E {
  public function toString():String { return "E!"; }
}
class F { }

var x:E = new E();
var o:Object = x;
var arr:Array = [x];
var f2:F = new F();
var b:Object = new Object();
var d:Dictionary = new Dictionary();
d["k"] = x;

eq("a" + x, "aE!", "static-typed concat dispatches toString");
eq("a" + o, "aE!", "Object-typed concat dispatches toString");
eq("a" + arr[0], "aE!", "any-typed array element dispatches toString");
eq(String(x), "E!", "String(x) dispatches toString");
eq(x + "b", "E!b", "concatenation on the right dispatches too");
eq("c" + b, "c[object Object]", "a plain Object prints as [object Object]");
eq("d" + f2, "d[object F]", "a non-overriding local class prints [object F], not its C name");
eq("" + f2, "[object F]", "and the same alone");
eq("" + x, "E!", "and an overriding one prints its own String");
eq("" + x.toString(), "E!", "explicit toString() is the same virtual call");
eq("" + d["k"], "E!", "a Dictionary value dispatches toString");
eq(String(null), "null", "null coerces to the string null");
// Not asserted: `Array`/`Function` still render their documented subset names
// ("[Array]"/"[Function]") rather than AIR's "[object Array]"/"function Function
// ..." (docs/zh-cn/as3-semantics.md §4) — a known simplification, not a probe.
trace("strcoerce: 12/12 object-to-String cases match adl 51.4.1");