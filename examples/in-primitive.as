// in-primitive.as — `key in <primitive receiver>` membership (AS3 autoboxing).
//
// AIR autoboxes a primitive receiver to its wrapper, so `in` answers the WRAPPER's
// member set, not false. Measured on adl 51.4.1 (temp/leaves/in):
//   Number/int/uint : Object.prototype names + toFixed/toExponential/toPrecision
//   Boolean         : Object.prototype names only
//   Function        : Object.prototype names + call/apply/length/prototype
// The Object.prototype names (toString/toLocaleString/valueOf/constructor/
// hasOwnProperty/propertyIsEnumerable/isPrototypeOf) are true for every wrapper.
//
// Covers BOTH emission paths: the boxed `any` receiver (as_in_v) and the
// statically typed receiver (emitIn's number/bool/function branches).
//
// Compile: as-aot examples/in-primitive.as --run

function check(actual:Boolean, expected:Boolean, label:String):void {
  if (actual !== expected) throw new Error("FAIL " + label + ": got " + actual + " want " + expected);
}

// ---- boxed `any` path (as_in_v) --------------------------------------------
var i:* = 5;        // int
var u:* = 7;        // uint
var n:* = 5.5;      // Number
var b:* = true;     // Boolean
var f:* = function():int { return 1; }; // Function

var protoNames:Array = ["toString", "toLocaleString", "valueOf", "constructor", "hasOwnProperty", "propertyIsEnumerable", "isPrototypeOf"];
for each (var nm:String in protoNames) {
  var o1:* = i; check(nm in o1, true, "boxed int " + nm);
  var o2:* = u; check(nm in o2, true, "boxed uint " + nm);
  var o3:* = n; check(nm in o3, true, "boxed Number " + nm);
  var o4:* = b; check(nm in o4, true, "boxed Boolean " + nm);
  var o5:* = f; check(nm in o5, true, "boxed Function " + nm);
}

// Number-only formatting trio.
var numOnly:Array = ["toFixed", "toExponential", "toPrecision"];
for each (var m:String in numOnly) {
  var ni:* = i; check(m in ni, true, "boxed int " + m);
  var nn:* = n; check(m in nn, true, "boxed Number " + m);
  var nb:* = b; check(m in nb, false, "boxed Boolean " + m);
  var nf:* = f; check(m in nf, false, "boxed Function " + m);
}

// Function-only surface.
var fnOnly:Array = ["apply", "call", "length", "prototype"];
for each (var fm:String in fnOnly) {
  var fi:* = i; check(fm in fi, false, "boxed int " + fm);
  var fb:* = b; check(fm in fb, false, "boxed Boolean " + fm);
  var ff:* = f; check(fm in ff, true, "boxed Function " + fm);
}

// ---- statically typed path (emitIn) ----------------------------------------
var si:int = 5;
var su:uint = 7;
var sn:Number = 5.5;
var sb:Boolean = true;
var sf:Function = function():int { return 1; };

check("toFixed" in si, true, "static int toFixed");
check("toString" in si, true, "static int toString");
check("isPrototypeOf" in si, true, "static int isPrototypeOf");
check("apply" in si, false, "static int apply");
check("toPrecision" in su, true, "static uint toPrecision");
check("toExponential" in sn, true, "static Number toExponential");
check("call" in sn, false, "static Number call");
check("valueOf" in sb, true, "static Boolean valueOf");
check("toLocaleString" in sb, true, "static Boolean toLocaleString");
check("toFixed" in sb, false, "static Boolean toFixed");
check("length" in sb, false, "static Boolean length");
check("apply" in sf, true, "static Function apply");
check("constructor" in sf, true, "static Function constructor");
check("toLocaleString" in sf, true, "static Function toLocaleString");
check("prototype" in sf, true, "static Function prototype");
check("toFixed" in sf, false, "static Function toFixed");
check("name" in sf, false, "static Function name");

trace("in-primitive: all ok");
