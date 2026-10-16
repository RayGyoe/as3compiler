// object-box.as -- what an Object-typed slot holds and how it behaves.
//
// AS3's Object is the universal base AND auto-boxes scalars, but on AIR a primitive
// stored in an Object slot stays a PRIMITIVE: `typeof` reports "boolean"/"string"/
// "number", `if (o)` applies the primitive's own ToBoolean, and String(o) gives the
// primitive's text (measured on adl 51.4.1 through a parameter -- so no constant
// folding -- in temp/apv/adl). Our Object slots are raw pointers and therefore BOX
// scalars (as_number_new / as_string_new / as_boolean_new), which leaked through
// three ways:
//
//   1. `if (o)` / `o || p` / `o ? a : b` tested the POINTER, so a slot holding false,
//      "" or 0 -- a non-NULL box -- was called TRUE.
//   2. String() of a boxed Boolean answered "[object Boolean]" instead of "false".
//   3. a null String/Function assigned to an Object slot became a non-NULL wrapper
//      around nothing: the same pointer test then called the branch TRUE and
//      talkmed-meeting's TKAppUpdate.loadComplete invoked a callback that was not
//      there (uncaught TypeError #1006).
//
// AIR's answers, all measured: false/""/0 -> F, true/"hi"/{}/a function -> T; a null
// String or Function assigned to an Object slot IS null (`o == null` true); and any
// function value stringifies to the constant "function Function() {}".

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// A parameter, so the compiler cannot fold the value into the test.
function truthy(v:Object):Boolean { return v ? true : false; }
function text(v:Object):String { return String(v); }

// --- 1. truthiness of a primitive in an Object slot ---------------------------
check(!truthy(false), "Object slot holding false is falsy");
check(truthy(true), "Object slot holding true is truthy");
check(!truthy(""), "Object slot holding the empty string is falsy");
check(truthy("hi"), "Object slot holding a non-empty string is truthy");
check(!truthy(0), "Object slot holding 0 is falsy");
check(truthy(2), "Object slot holding 2 is truthy");
check(!truthy(null), "Object slot holding null is falsy");
check(truthy({}), "a plain object is truthy");

// --- 2. the same through `||` (which passes the operand through, not a bool) ---
var zero:Object = 0;
var five:Object = 5;
check((zero || five) == 5, "a falsy boxed 0 falls through to the right operand");
check((five || zero) == 5, "a truthy boxed 5 is passed through as-is");

// --- 3. String() of a boxed scalar / a function value -------------------------
check(text(false) == "false", "String(Object holding false), got '" + text(false) + "'");
check(text(true) == "true", "String(Object holding true)");
check(text(0) == "0", "String(Object holding 0)");
check(text("") == "", "String(Object holding an empty string)");

function hi():void { }
check(String(hi) == "function Function() {}", "String(function value), got '" + String(hi) + "'");

// --- 4. null String / Function in an Object slot IS null ----------------------
var nullString:String = null;
var nullFn:Function = null;
var o1:Object = nullString;
var o2:Object = nullFn;
check(o1 == null, "a null String lands as null, not a wrapper");
check(o2 == null, "a null Function lands as null, not a wrapper");
var called:Boolean = false;
if (o2) { called = true; }
check(!called, "the null callback is not invoked (the #1006 guard holds)");

// --- 5. a null Function with the STATIC type Function is "null", not the text ---
var nf:Function = null;
if (nf) { called = true; }
check(!called, "a statically-typed null Function is falsy");
check(String(nf) == "null", "String(static null Function), got '" + String(nf) + "'");

// --- 6. a non-null function value with the static type Function ----------------
check(String(hi) == "function Function() {}", "String(static Function), got '" + String(hi) + "'");

var nullString:String = null;
var nullFn:Function = null;

// --- 7. Object(null) / Object(undefined) are FRESH EMPTY OBJECTS ----------------
// "Every value is an object": the conversion returns the value itself, with one
// exception -- null and undefined produce a new empty Object, so `Object(null)`
// is NOT null. Measured on adl 51.4.1 (temp/xmlmeth, temp/d31probe/adl):
// `Object(null) == null` is false, `String(Object(null))` is "[object Object]",
// and it is true for a statically null operand AND for a `*` holding null or
// undefined. Ours boxed the operand through as_v_to_obj, which hands back the
// very null-box it was given, so `Object(null) === null` was true here.
var fromNull:Object = Object(null);
check(fromNull != null, "Object(null) is not null");
check(String(fromNull) == "[object Object]", "String(Object(null)), got '" + String(fromNull) + "'");
check(typeof fromNull == "object", "typeof Object(null) is object");
var fromUndef:Object = Object(undefined);
check(fromUndef != null, "Object(undefined) is not null");
check(String(fromUndef) == "[object Object]", "String(Object(undefined)), got '" + String(fromUndef) + "'");
var dynNull:* = null;
var dynUndef:* = undefined;
check(Object(dynNull) != null, "a `*` holding null still yields a fresh object");
check(Object(dynUndef) != null, "a `*` holding undefined still yields a fresh object");
// ...and the fresh object is a usable dynamic one.
fromNull.zz = 5;
check(fromNull.zz == 5 && fromNull.hasOwnProperty("zz"), "the fresh object takes dynamic members");
// Everything else is untouched by the conversion.
check(Object(5) === 5, "Object(5) IS the primitive 5 (not a box)");
check(typeof Object("x") == "string", "Object(\"x\") stays a String");
check(String(Object()) == "[object Object]", "the no-argument form is still an empty object");

trace("object-box: ok");
