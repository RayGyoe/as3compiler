// Regression: a typed `const` local captured by a closure must read its real
// value, never an uninitialised activation-cell slot.
//
// `const` bindings are immutable and block-scoped (unlike `var`, which is
// function-scoped and hoisted). Registering a captured `const` as an
// activation-cell field was therefore wrong: cell fields are written by the
// *declaring* body through `cell->field`, and only hoisted `var` locals get such
// a write. A captured `const` produced a cell field that was never assigned --
// gc_alloc zeroes the struct, so every closure read `env->cellN->name` == NULL and
// dereferencing it segfaulted. Starling Demo's CustomHitTestScene hit exactly this
// (`const texts:Array` used inside the TRIGGERED listener) and crashed on the first
// click of its "Hold me!" button.
//
// `const` is now captured *by value* into the closure environment, which is
// semantically identical for an immutable binding. The enclosing body keeps its
// block-scoped C local, and the env carries a copy (marked by the env's mark fn,
// so the GC keeps it alive).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ------------------------- 1) const array indexed from a closure (the crash)
var out:String = "";

function makeCounter():Function {
    const texts:Array = ["a", "b", "c"];
    var hit:int = 0;
    return function():void { hit++; out += texts[hit % texts.length]; };
}

var f:Function = makeCounter();
f(); f(); f(); f();
check(out == "bcab", "a closure must read a captured const array (got '" + out + "')");

// ------------------------- 2) const object / primitive, block-scoped
// A `const` is block-scoped (unlike `var`, which is function-scoped and hoisted),
// so a nested function that references it before the declaration is a genuine
// use-before-declaration and is rejected loudly at compile time -- that stays
// unchanged; only the after-declaration capture is exercised here.
var blockStr:String = "";
function blockCapture():Function {
    const tag:String = "block-const";
    var cb:Function = function():void { blockStr = tag + "!" };
    cb();
    return cb;
}
blockCapture();
check(blockStr == "block-const!", "const in a block must be captured (got '" + blockStr + "')");

// ------------------------- 3) const inside a loop: one binding per iteration
var joined:String = "";
function perIteration():void {
    var fns:Array = [];
    for (var i:int = 0; i < 3; i++) {
        const label:String = "L" + i;
        fns.push(function():void { joined += label; });
    }
    for each (var g:Function in fns) g();
}
perIteration();
check(joined == "L0L1L2", "each loop iteration's const must be captured separately (got '" + joined + "')");

// ------------------------- 4) captured const keeps its referent alive across a GC
// The env holds the array by value, and the env's mark fn must mark it; otherwise
// the collection below sweeps the array while the closure still points at it.
// (The `any + any` concatenation this relies on was a gap when this group was
// written; stage 89-34 fixed it, so it is exercised in its natural form now —
// see examples/any-add.as.)
var survive:String = "";
function gcSurvivor():Function {
    const words:Array = ["keep", "me"];
    return function():void { System.gc(); survive = words[0] + words[1]; };
}
gcSurvivor()();
check(survive == "keepme", "a captured const must survive a collection (got '" + survive + "')");

// ------------------------- 5) const in a block that also holds a mutable var
// The const (by value) and the var (by reference, in the cell) must not be
// confused with one another.
var mixed:String = "";
function mixedCapture():Function {
    const prefix:String = "<";
    var suffix:String = ">";
    var cb:Function = function():void { mixed = prefix + suffix; };
    suffix = "!";
    cb();
    return cb;
}
mixedCapture();
check(mixed == "<!", "const by value and var by reference coexist (got '" + mixed + "')");

trace("closure-const-regression OK");