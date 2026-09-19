// stage77.as — exception-stack hygiene for early exits from try blocks (stage 77):
// a `return`/`break`/`continue` inside `try` must pop the setjmp handler stack
// (`as_jmp_depth--`) and run any pending `finally` before jumping out. Without
// this, the handler depth leaks +1 and a later throw longjmps to a dead stack
// frame (crash/UB); and `finally` would be skipped on the early exit.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var order:String = "";

// --- 1. return inside try/catch must not leak the handler stack ---
function retInCatch():void {
  try { return; } catch (e:Error) { trace("unreachable"); }
}

// --- 2. return inside try/finally must run finally (and keep the return value) ---
function retInFinally():int {
  try {
    return 42;
  } finally {
    order += "F";
  }
  return -1;
}

// --- 3. break inside try/finally runs finally, then pops the stack ---
function breakInFinally():int {
  var i:int = 0;
  while (i < 10) {
    i++;
    try {
      break;
    } finally {
      order += "B";
    }
  }
  return i;
}

// --- 4. continue inside try/finally runs finally each iteration ---
function continueInFinally():int {
  var n:int = 0;
  var i:int = 0;
  while (i < 3) {
    i++;
    try {
      continue;
    } finally {
      order += "C";
    }
    n += 100;
  }
  return n;
}

// --- 5. nested try/finally: innermost finally runs first, then outer ---
function nestedFinally():int {
  try {
    try {
      return 1;
    } finally {
      order += "i";
    }
  } finally {
    order += "o";
  }
  return -1;
}

// --- 6. return inside catch runs the finally ---
function retFromCatch():int {
  try {
    throw new Error("x");
  } catch (e:Error) {
    return 5;
  } finally {
    order += "c";
  }
  return -1;
}

// --- 7. return inside finally overrides the pending return value ---
function retInFinallyBody():int {
  try {
    return 10;
  } finally {
    return 20;
  }
  return -1;
}

// --- 8. break inside try/finally within a for-in loop (also runs finally) ---
function breakInForIn():int {
  var a:Array = [10, 20, 30, 40];
  var sum:int = 0;
  for (var i:int in a) {
    try {
      if (a[i] == 30) break;
      sum += a[i];
    } finally {
      order += "f";
    }
  }
  return sum;
}

retInCatch();
trace("after retInCatch (stack intact)");

// Throw right after the early return to prove the handler stack is balanced.
try {
  throw new Error("boom");
} catch (e:Error) {
  check(e.message == "boom", "handler stack intact after early return");
}

check(retInFinally() == 42 && order == "F", "finally runs on return; value preserved");
order = "";
check(breakInFinally() == 1 && order == "B", "finally runs on break");
order = "";
check(continueInFinally() == 0 && order == "CCC", "finally runs on continue (3x)");
order = "";
check(nestedFinally() == 1 && order == "io", "nested finally innermost-first");
order = "";
check(retFromCatch() == 5 && order == "c", "finally runs on return-from-catch");
check(retInFinallyBody() == 20, "return-in-finally overrides value");
order = "";
check(breakInForIn() == 30 && order == "fff", "finally runs on break in for-in");

trace("stage77: all try/finally early-exit assertions passed");
