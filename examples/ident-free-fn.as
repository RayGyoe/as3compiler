// Top-level FREE FUNCTIONS were the one identifier class the C naming sanitizer
// did not cover (阶段七十六 covered class/method/field/local/param/module
// variables; `main` got a bespoke rename in user-main.as). Their C symbol was the
// raw AS3 name, so four measured collisions reached clang:
//
//   function log(x:Number)      -> `log`    vs <math.h>      "static declaration of
//                                              'log' follows non-static declaration"
//   function index(s:String)    -> `index`  vs <string.h>    (legacy BSD alias)
//   function Sprite():int       -> `Sprite` vs the C typedef  "redefinition of
//                                              'Sprite' as different kind of symbol"
//   function max(a,b) (Windows) -> `max`    vs <windef.h>'s  "expected identifier or '('"
//                                              `#define max(a,b)`  (NOMINMAX unset)
//
// `adl`/`mxmlc` run every one of these fine (§1.5 => 遗留缺陷). The fix renames
// ONLY the C symbol (`_log`, `_index`, `_Sprite`, `_max`), at every emission site
// — prototype, definition, direct call, Function value and its `__call` thunk —
// so the AS3-visible name is untouched. Object-like host macros (`near`/`far`/
// `small`) are a different hazard (they rewrite the identifier EVERYWHERE, struct
// bodies included) and are handled by the preamble's `#undef` block instead; the
// `near()` below is the regression for that half on Windows.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. libc / libm symbols -------------------------------------------------
function log(x:Number):Number { return x * 10; }
function index(s:String):String { return "i:" + s; }
function pow(x:Number, y:Number):Number { return x + y; }

// --- 2. a C TYPE name (the class typedef `Sprite`) --------------------------
function Sprite():int { return 42; }

// --- 3. host FUNCTION-LIKE macros (expanded only at a bare call site) -------
function min(a:Number, b:Number):Number { return a < b ? a : b; }
function max(a:Number, b:Number):Number { return a > b ? a : b; }
function isnan(x:Number):Boolean { return x !== x; }

// --- 4. host OBJECT-LIKE macros, undeclared by the preamble's #undef block ---
// These rewrite the identifier EVERYWHERE (struct bodies included), which is why
// the preamble `#undef`s them instead of the emitter renaming anything. The
// MEASURED cases were a field named `small` (<rpcndr.h> `#define small char`) and a
// field named `_timezone` (UCRT <time.h>); the free functions below plus the
// fields inside MacroHost pin that the undef list covers both spellings. (`near` is
// the case the old row measured on Windows: 6 examples' `near()` assertion helpers.)
function near(a:Number, b:Number):Boolean { return Math.abs(a - b) < 1e-9; }
function far(a:Number):Number { return a * 2; }
function small():String { return "s"; }

class MacroHost {
  public var near:int = 1;
  public var far:int = 2;
  public var small:int = 3;
  public var huge:int = 4;
  public var OUT:int = 5;
}

// --- 5. sanitize collision pair: `log` takes `_log`, so `_log` must take `__log`
function _log(x:Number):Number { return x * 100; }

// --- 6. `main` keeps its bespoke rename (regression for user-main.as) -------
function main():int { return 1; }

check(log(5) == 50, "top-level `log` (libm) callable");
check(_log(5) == 500, "the sanitize collision pair `log`/`_log` stays distinct");
check(index("x") == "i:x", "top-level `index` (libc legacy alias) callable");
check(pow(2, 3) == 5, "top-level `pow` (libm) callable");
check(Sprite() == 42, "top-level `Sprite` (C typedef) callable");
check(min(2, 3) == 2 && max(2, 3) == 3, "macro-named `min`/`max` are real functions");
check(!isnan(1) && isnan(0 / 0), "macro-named `isnan` is a real function");
check(near(1.0, 1.0) && !near(1.0, 1.1), "macro-named `near` is a real function");
check(far(3) == 6 && small() == "s", "the rest of the object-like macro family too");
var mh:MacroHost = new MacroHost();
check(mh.near == 1 && mh.far == 2 && mh.small == 3 && mh.huge == 4 && mh.OUT == 5,
  "fields spelled like Windows object-like macros keep their names and values");
check(main() == 1, "user `main()` is callable while the C entry point stays `main`");

// Every one of them is also reachable as a Function VALUE (the rename must reach
// the `__call` thunk too, or the value call would still name the clashing symbol).
var f:Function = log;
check(f(2) == 20, "`log` as a Function value");
var g:Function = min;
check(g(4, 1) == 1, "`min` as a Function value");

trace("ident-free-fn: all checks passed");
