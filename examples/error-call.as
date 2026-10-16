// A one-argument call whose callee names a class is AS3's `Type(expr)`
// conversion -- NOT `new`. AIR resolves it by class, and the classes split in
// two (measured on adl 51.4.1: temp/errcall, temp/errcall4, temp/errsub):
//
//   * The NATIVE Error family CONSTRUCTS, exactly like `new Error(x)` --
//     Error, TypeError, RangeError, ArgumentError, SyntaxError, ReferenceError,
//     DefinitionError, VerifyError, EvalError, URIError, UninitializedError,
//     SecurityError (`TypeError(5)` is a TypeError whose message is "5", and
//     `name` is the subclass's own). RegExp constructs too, and the
//     E4X-transparent Namespace stub.
//   * EVERY OTHER class COERCES at RUN time: null/undefined -> null, an instance
//     (or subclass instance) -> that very instance, anything else -> TypeError
//     #1034. That includes the pure-AS3 flash.errors subclasses (IOError,
//     EOFError, SQLError, ...) and a user subclass of Error -- only the native
//     classes carry a constructor call behaviour.
//
// This rule used to be emitted as a bare C pointer cast (`(Error*)("msg")`),
// which boxed a STRING BODY as a tag-4 object: the first `catch (e:Error)` read
// that text as a vtable and SIGSEGV'd. That was the talkmed-meeting
// close-the-window crash (`throw Error('...')` in ANECefWebView.destroy -- a
// pattern used 70 times in that app alone).
import flash.errors.IOError;
import flash.errors.EOFError;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Foo { }

class MyErr extends Error {
  public function MyErr(m:* = "", id:int = 0) { super(m, id); }
}

function run():void {
  var v:* = null;
  var id:int = -1;

  // 1. Error("msg") constructs, and what comes out is a real Error.
  var e1:* = Error("boom");
  check(e1 is Error, "Error(msg) is an Error");
  check(e1.message == "boom", "Error(msg).message == the message");
  check(e1.name == "Error", "Error(msg).name == Error");
  check(e1.errorID == 0, "Error(msg).errorID == 0");
  // The shape that used to crash: a caught Error whose vtable is a string body.
  var caught:String = "";
  try { throw Error("crux"); } catch (e:Error) { caught = e.message; check(e.name == "Error", "caught.value.name"); }
  check(caught == "crux", "throw Error(msg) is caught by catch (e:Error)");
  // `Error(x)` is `new Error(x)` (same message/name, not identity).
  // (The no-new form takes exactly ONE argument: `Error(msg, id)` without `new`
  // is rejected by mxmlc -- "参数的数量不正确。不超过 1 个" -- and by this compiler.)
  var e2:* = new Error("boom");
  check(e2.message == e1.message && e2.name == e1.name, "Error(x) matches new Error(x)");
  var caught2:String = "";
  try { throw new Error("m", 42); } catch (e:Error) { caught2 = e.message + "/" + e.errorID; }
  check(caught2 == "m/42", "new Error(msg, id) keeps the id");

  // 2. The whole native family constructs, and keeps its own class name.
  var t:* = TypeError(5);
  check(t is TypeError && t is Error, "TypeError(5) is a TypeError and an Error");
  check(t.name == "TypeError" && t.message == "5", "TypeError(5) name/message");
  var r:* = RangeError(5);
  check(r.name == "RangeError" && r.message == "5", "RangeError(5) name/message");
  var sd:* = SecurityError(5);
  check(sd.name == "SecurityError" && sd.message == "5", "SecurityError(5) name/message");
  var ue:* = UninitializedError(5);
  check(ue.name == "UninitializedError" && ue.message == "5", "UninitializedError(5) name/message");
  var re:* = ReferenceError(5);
  check(re.name == "ReferenceError" && re.message == "5", "ReferenceError(5) name/message");

  // 3. A non-string message stringifies like the String slot does: AIR stores the
  //    operand RAW in an untyped slot (`Error(5).message === 5` is true there,
  //    and `Error(null).message === null`), while this subset's message field is
  //    a String, so the value is converted once at construction. The
  //    observable-for-string-code results below agree either way (`5 == "5"`,
  //    and a null message renders "null" in a concatenation).
  check(String(Error(5).message) == "5", "Error(5).message reads as \"5\"");
  check(String(Error(true).message) == "true", "Error(true).message reads as \"true\"");
  check(String(Error({ a: 1 }).message) == "[object Object]", "Error(obj).message reads as \"[object Object]\"");
  check(String(Error(new Error("p")).message) == "Error: p", "Error(err).message reads as \"Error: p\"");
  check("" + Error(null).message == "null", "a null message renders \"null\"");
  check(Error("").message == "", "an empty message stays empty");

  // 4. Every other class coerces, and a failed coercion is #1034.
  id = -1; try { v = Sprite(5); } catch (x:*) { id = x.errorID; }
  check(id == 1034, "Sprite(5) throws #1034");
  id = -1; try { v = Foo(5); } catch (x:*) { id = x.errorID; }
  check(id == 1034, "a user class call coerces (#1034)");
  // ... including the flash.errors subclasses and a user subclass of Error,
  // which are NOT native and therefore have no call behaviour.
  id = -1; try { v = IOError(5); } catch (x:*) { id = x.errorID; }
  check(id == 1034, "IOError(5) coerces (#1034)");
  id = -1; try { v = EOFError(5); } catch (x:*) { id = x.errorID; }
  check(id == 1034, "EOFError(5) coerces (#1034)");
  id = -1; try { v = MyErr(5); } catch (x:*) { id = x.errorID; }
  check(id == 1034, "a user subclass of Error still coerces (#1034)");

  // 5. null/undefined coerce to null; an instance comes back unchanged.
  v = null;
  v = Foo(null); check(v == null, "Foo(null) -> null");
  v = Sprite(null); check(v == null, "Sprite(null) -> null");
  var mine:MyErr = new MyErr("q");
  v = MyErr(mine); check(v == mine, "MyErr(instance) -> the same instance");
  var sp:Sprite = new Sprite();
  v = Sprite(sp); check(v == sp, "Sprite(instance) -> the same instance");

  // 6. RegExp/Namespace construct (RegExp keeps its source).
  var rx:* = RegExp("a");
  check(rx is RegExp, "RegExp(\"a\") is a RegExp");
  check(rx.source == "a", "RegExp(\"a\").source == \"a\"");
  var ns:* = Namespace("u");
  check(ns is Namespace, "Namespace(\"u\") is a Namespace");

  // 7. The conversion FUNCTIONS are untouched by the rule above.
  v = String(5); check(v == "5", "String(5) == \"5\"");
  v = Number("3"); check(v == 3, "Number(\"3\") == 3");
  v = Boolean(0); check(v == false, "Boolean(0) == false");
  v = int("4"); check(v == 4, "int(\"4\") == 4");
  v = Object(5); check(v == 5 && typeof v == "number", "Object(5) stays a number");
  v = Array(5); check(v.length == 5, "Array(5).length == 5");

  trace("error-call: all checks passed");
}

run();
