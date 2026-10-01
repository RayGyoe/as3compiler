// Regression: closures capture *variables by reference* (AVM2 activation
// objects), not snapshots. Each block pins one previously broken behaviour:
// before the per-function activation cells, a closure captured the value a
// local happened to hold when the closure was created, so
//   1) assigning the local *after* creating the closure was invisible to it
//      (Starling's AtfTextureFactory does exactly this: `onReady` is installed
//      first, `var texture:Texture` is assigned afterwards -> the factory's
//      `AssetManager.onAssetLoaded(name, texture)` step silently saw null);
//   2) mutating a captured local inside a closure never reached the enclosing
//      body;
//   3) two closures over the same local did not share one slot;
//   4) a grandchild closure (depth 2) did not see the outer method's locals;
//   5) a nested function *declaration* captured by reference read as null;
//   6) a local of a closure body, captured by *its* inner closure, was a
//      snapshot (depth-2 activation cell).
// Parameters must still be captured by value (a parameter is not an activation
// slot), and `var` hoisting must still make one shared cell per function (the
// loop case: all three closures must read the final value, as in AVM2).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var log:String = "";
function say(s:String):void { log += s + "|"; }

// ------------------------------------------- 1) local assigned after creation
var lateSeen:String = "unset";
(function():void {
    var t:String = null;
    var cb:Function = function():void { lateSeen = t; };
    t = "value-1";
    cb();
})();
check(lateSeen == "value-1", "closure must see an assignment made after it was created (saw " + lateSeen + ")");

// ------------------------------------------------- 2) closure writes the local
var n:int = 0;
function bump():void {
    var local:int = 0;
    var inc:Function = function():void { local += 1; };
    inc(); inc(); inc();
    n = local;
}
bump();
check(n == 3, "closure writes must be visible to the enclosing body (n=" + n + ")");

// --------------------------------------------- 3) two closures share the slot
function twoClosures():String {
    var s:String = "a";
    var put:Function = function():void { s = "b"; };
    put();
    s += "!";                       // body writes the same slot after the closure
    var read:Function = function():String { return s; };
    return read();
}
check(twoClosures() == "b!", "two closures over one var must share it (got " + twoClosures() + ")");

// --------------------------------------------------- 4) depth-2 grandchild
var depth2:String = "";
function makeGrader():Function {
    var v:String = "outer-4";
    var mk:Function = function():Function {
        return function():void { depth2 = v; };
    };
    var inner:Function = mk();
    v = "outer-4b";                  // assigned after *both* closures exist
    return inner;
}
makeGrader()();
check(depth2 == "outer-4b", "grandchild closure must see the (re)assigned local (saw " + depth2 + ")");

// --------------------------------------- 5) nested function declaration
var saved:Function = null;
var lateCall:String = "";
function install():void {
    var t:String = null;
    saved = onReady;                 // the closure escapes *before* the assign
    t = "value-5";
    function onReady():void { lateCall = t; }
}
install();
saved.call(null);
check(lateCall == "value-5", "nested function declaration must capture by reference (saw " + lateCall + ")");

// --------------------------------------------- 6) parameters stay by value
function paramCap(v:String):Function {
    return function():String { return v; };
}
check(paramCap("value-6")() == "value-6", "a captured parameter is a by-value copy");

// --------------------------------------- 7) depth-2 activation cell (closure body)
var twoLevel:String = "";
function outer7():Function {
    var mk:Function = function():Function {
        var t:String = null;
        var inner:Function = function():void { twoLevel = t; };
        t = "value-7";               // closure body's own local, assigned late
        return inner;
    };
    return mk();
}
outer7()();
check(twoLevel == "value-7", "a closure body's captured local must be a shared cell (saw " + twoLevel + ")");

// ------------------------------------------- 8) `var` hoisting share
// Inside a *function* body, `var` is function-scoped: every closure created in the
// loop shares one cell, so they all read the final value (AVM2 share semantics).
function loopShare():String {
    var fns:Array = [];
    for (var i:int = 0; i < 3; i++) {
        var lbl:String = "L" + i;
        fns.push(function():void { say(i + "" + lbl); });
    }
    for each (var f:Function in fns) f();
    return log;
}
check(loopShare() == "3L2|3L2|3L2|", "var hoisting: closures share one cell holding the final value (log=" + log + ")");

trace("closure-ref-regression OK");