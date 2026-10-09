// Named function expressions: `function name(...) {}` in expression position.
//
// AS3 (ES3) semantics: the name is bound ONLY inside the function's own body.
// It supports recursive self-reference and must never leak into the enclosing
// scope. This example pins down both halves of that rule.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1) direct recursion ---
var fact:Function = function f(n:int):int { if (n <= 1) return 1; return n * f(n - 1); };
check(fact(5) == 120, "recursive named function expression, got " + fact(5));
check(fact.length == 1, "Function.length, got " + fact.length);

// --- 2) recursion combined with capture of an enclosing variable ---
var base:int = 10;
var stair:Function = function step(n:int):int { if (n <= 0) return base; return step(n - 1) + 1; };
check(stair(3) == 13, "recursive closure over a captured var, got " + stair(3));

// --- 3) the name is body-local: an outer name of the same spelling is untouched ---
var shadowed:int = 1;
var peek:Function = function shadowed():int { return 2; };
check(peek() == 2, "body-local name usable inside its own body");
check(shadowed == 1, "outer name of the same spelling is unaffected, got " + shadowed);

// --- 4) the shape Starling/AIR code uses: named callbacks passed as arguments ---
// A Function value is arity-checked at the call: AIR raises #1063 when a closure
// is invoked with fewer arguments than its declared parameter list (measured on
// adl 51.4.1, temp/pkgA/arity + arity2: 'Expected <required>, got <argc>').
var log:String = "";
var run:Function = function run(onDone:Function):void { onDone(); };
run(function onComplete():void { log += "C"; });
// A callback that declares a parameter must RECEIVE it: 'onError()' below would
// be #1063, so the caller passes the Error it promised.
var handle:Function = function handle(onErr:Function):void { onErr(new Error("boom")); };
handle(function onError(e:Error):void { log += "E" + (e.errorID == 0 ? "!" : "?"); });
check(log == "CE!", "named callbacks as arguments, got '" + log + "'");

// --- 4b) the mismatched call is an error, and nothing of the callback runs ---
var caught:String = "";
try { run(function onBad(e:Error):void { log += "B"; }); }
catch (e:Error) { caught = "" + e.errorID; }
check(caught == "1063", "a 0-arg call of a 1-param callback raises #1063, got '" + caught + "'");
check(log == "CE!", "the aborted call added nothing, got '" + log + "'");

// --- 5) the name is reachable from a nested closure inside the body ---
var deep:Function = function d(n:int):int {
  if (n <= 0) return 0;
  var inner:Function = function():int { return d(n - 1) as int; };
  return inner() + 1;
};
check(deep(3) == 3, "self-reference from a nested closure, got " + deep(3));

// --- 6) a named function expression is a first-class value like any other ---
var sq:Function = function square(x:int):int { return x * x; };
check(sq(7) == 49, "value call");

trace("named-fn-expr: all assertions passed");