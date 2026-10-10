// An ACCESSOR named as a method (`obj.prop()`) is read-then-call in AIR: the
// property value is read and then invoked, so a getter called as a method throws
// TypeError #1006 ("value is not a function.") unless the getter's value is
// itself callable. Measured on adl 51.4.1 (temp/qfix/gcadl) for BOTH a class
// receiver and an interface receiver. Previously the interface form returned the
// getter's value directly (silently diverging from AIR); the class form failed to
// compile.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

interface IHelper {
  function get targetBounds():int;
}

class Widget {
  public function get size():int { return 7; }
  public function get cb():Function { return mk; }
  private function mk():String { return "CALLED"; }
  public function plain():int { return 3; }
}

class Sub extends Widget {
  override public function get size():int { return 99; }
}

class Helper implements IHelper {
  public function get targetBounds():int { return 100; }
}

function run():void {
  var w:Widget = new Widget();

  // Reading an accessor is unaffected.
  check(w.size == 7, "class getter read");
  check(w.plain() == 3, "real method still callable");

  // Calling a class getter as a method is #1006, not the value 7.
  var e1:int = 0;
  try { w.size(); } catch (e:*) { e1 = e.errorID; }
  check(e1 == 1006, "class getter-as-method throws #1006");

  // A getter whose value IS a function is invoked (read-then-call).
  check(w.cb() == "CALLED", "callable getter is invoked");

  // Virtual dispatch still applies to the property read.
  var b:Widget = new Sub();
  check(b.size == 99, "overridden getter read is virtual");
  var e2:int = 0;
  try { b.size(); } catch (e:*) { e2 = e.errorID; }
  check(e2 == 1006, "overridden getter-as-method throws #1006");

  // Interface receiver: same rule.
  var h:IHelper = new Helper();
  check(h.targetBounds == 100, "interface getter read");
  var e3:int = 0;
  try { h.targetBounds(); } catch (e:*) { e3 = e.errorID; }
  check(e3 == 1006, "interface getter-as-method throws #1006");

  var g:Helper = new Helper();
  var e4:int = 0;
  try { g.targetBounds(); } catch (e:*) { e4 = e.errorID; }
  check(e4 == 1006, "class receiver of an interface getter throws #1006");

  // The error message matches AIR verbatim.
  var msg:String = "";
  try { w.size(); } catch (e:* ) { msg = (e as Error).message; }
  check(msg == "Error #1006: value is not a function.", "message matches AIR");

  trace("getter-call: all checks passed");
}

run();
