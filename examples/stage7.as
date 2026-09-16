function divide(a:Number, b:Number):Number {
  if (b == 0) {
    throw new Error("division by zero");
  }
  return a / b;
}

trace("start");

// basic try/catch
try {
  divide(10, 0);
} catch (e:Error) {
  trace("caught:", e.message);
}

// no exception path
try {
  trace("divide 10/2 =", divide(10, 2));
} catch (e:Error) {
  trace("should not happen");
}

// finally always runs
try {
  trace("try with finally");
} finally {
  trace("finally runs");
}

// throw a string
try {
  throw "oops";
} catch (e:Error) {
  trace("caught string:", e.message);
}

// rethrow from catch
function check(x:int):void {
  try {
    if (x < 0) throw new Error("negative");
  } catch (e:Error) {
    trace("caught negative, rethrow");
    throw e;
  }
}
try {
  check(-1);
} catch (e:Error) {
  trace("outer caught:", e.message);
}

// nested try
try {
  try {
    throw new Error("inner");
  } catch (e:Error) {
    trace("inner caught:", e.message);
    throw new Error("outer");
  }
} catch (e:Error) {
  trace("outer caught:", e.message);
}

trace("done");
