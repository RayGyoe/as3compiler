// Stage 330: a script-level assignment to an undeclared name creates a global.
//
// AIR's frame scripts are NON-STRICT, so `gvar = 42;` at script level declares the
// global implicitly and `trace(gvar)` reads it back. mxmlc rejects the very same
// statement inside a class method ("Access of possibly undefined property gvar",
// measured on 51.4.1, temp/implicit/), so the strictness boundary is the script
// scope: class and package scopes keep their compile error.
//
// A frame script cannot be produced by mxmlc (timeline scripts only come out of a
// .fla), so the non-strict half is the one place where this compiler follows ES3's
// own rule instead of an adl reading; the strict half IS measured.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 1. A plain assignment declares the global; the read afterwards sees the value.
gvar = 42;
check(gvar == 42, "a script-level assignment creates the global, got " + gvar);

// 2. `+` on a Number global must stay numeric, not become a string concat: the
//    slot is `*`-typed, so this goes through the dynamic add path exactly like an
//    untyped variable would.
gvar = gvar + 8;
check(gvar == 50, "the global keeps its numeric value, got " + gvar);

// 3. A compound assignment on a FRESH global reads `undefined` first, and ES3
//    turns undefined into 0 for `+=`... which is why `counter += 5` alone would be
//    NaN. Start from an explicit 0 and the compound form works normally.
counter = 0;
counter += 5;
check(counter == 5, "compound assignment on an implicit global, got " + counter);

// 4. Inside `with`, a name the object does NOT have falls through to the script
//    scope (ES3 resolves through the object only when it has the property), so the
//    write creates the global and leaves the object untouched.
var obj:Object = { a: 1 };
with (obj) { missing = 7; }
check(missing == 7, "a with-fallthrough write creates the global, got " + missing);
check(obj.missing === undefined, "the with object is not given the property");

// 5. A declared variable still wins over the implicit-global slot.
var declared:Number = 1;
declared = declared + 1;
check(declared == 2, "declared variables are unaffected, got " + declared);

trace("implicit-global: OK");