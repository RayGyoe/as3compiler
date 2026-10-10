// AIR validates DisplayObject.name against null/undefined: the write throws
// TypeError #2007 ("Parameter name must be non-null.") and the old value stays.
// Measured on adl 51.4.1 (temp/qfix/gcadl/result16.txt) for the static slot,
// `this.name`, an unqualified `name` inside a subclass method, `super.name`, and
// a dynamic `*` / `Object` receiver -- all #2007. Error.name is a plain String
// slot and does NOT throw (also measured there).
import flash.display.Sprite;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function errId(fn:Function):int {
  try { fn(); } catch (e:Error) { return e.errorID; }
  return 0;
}

class NameSub extends Sprite {
  public function probeUnqualified():int {
    try { name = null; } catch (e:Error) { return e.errorID; }
    return 0;
  }
  public function probeThis():int {
    try { this.name = undefined; } catch (e:Error) { return e.errorID; }
    return 0;
  }
  public function probeSuper():int {
    try { super.name = null; } catch (e:Error) { return e.errorID; }
    return 0;
  }
}

function run():void {
  var s:Sprite = new Sprite();
  s.name = "abc";
  check(s.name == "abc", "a normal assignment stores the name");

  // The static slot: the throw leaves the previous value in place.
  var id:int = errId(function ():void { s.name = null; });
  check(id == 2007, "name = null throws #2007, got #" + id);
  check(s.name == "abc", "a rejected write leaves the old name");

  id = errId(function ():void { s.name = undefined; });
  check(id == 2007, "name = undefined throws #2007 too, got #" + id);

  var d:* = s;
  id = errId(function ():void { d.name = null; });
  check(id == 2007, "a dynamic * receiver throws #2007, got #" + id);

  var o:Object = s;
  id = errId(function ():void { o.name = null; });
  check(id == 2007, "an Object receiver throws #2007, got #" + id);

  var sub:NameSub = new NameSub();
  id = sub.probeUnqualified();
  check(id == 2007, "unqualified name = null throws #2007, got #" + id);
  id = sub.probeThis();
  check(id == 2007, "this.name = undefined throws #2007, got #" + id);
  id = sub.probeSuper();
  check(id == 2007, "super.name = null throws #2007, got #" + id);

  // Error.name is a plain String slot: null is stored, no throw (adl agrees).
  var err:Error = new Error("x");
  err.name = null;
  check(err.name == null, "Error.name accepts null");

  trace("name-null ok");
}

run();
