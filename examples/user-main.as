// A user `function main()` must not collide with the emitter's C entry point.
// The emitter unconditionally generates `int main(void)`, so a top-level
// `function main()` (legal in AIR, and a natural entry-point name) used to fail
// with `conflicting types for 'main'`. It is now emitted as `asc_user_main` at
// every site (definition, call, function value), while the generated entry still
// runs the module's top-level statements.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var ran:Boolean = false;

function main():void {
  ran = true;
}

function helper():int { return 5; }

// Callable by its own name, both directly and through a Function value.
main();
check(ran, "user main() is callable by name");
ran = false;
var f:Function = main;
f();
check(ran, "user main() is callable through a Function value");

check(helper() == 5, "other free functions are unaffected");

trace("user-main: all checks passed");
