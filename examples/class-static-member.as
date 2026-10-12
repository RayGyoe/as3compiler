// Stage 138 (prerequisite P for flash.data/SQLite): a Class VALUE resolves the
// class's STATIC members, and a computed static getter is INVOKED. Measured on
// adl 51.4.1 (temp/adlprobe/adl.txt section 1): c.thing (static getter) -> THING,
// c.plain (static var) -> PLAIN, c.KONST (static const) -> KONST, c.greet()
// (static method) -> HI; a name that is not a static member reads undefined and
// does NOT throw.
//
// Before the fix only the three non-getter shapes worked; the getter threw a bare
// Error id=0, and a BUILT-IN class's Class value never wired its static table at
// all (so `myClass.nativeApplication` read undefined and the caller's `if` branch
// was silently skipped -- exactly the shape Application.NativeApplication uses in
// com.vsdevelop.framework.application.Application, which is what blocked the real
// app's SQLite code path before it could even be entered).
import flash.desktop.NativeApplication;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Holder {
  public static function get thing():String { return "THING"; }
  public static var plain:String = "PLAIN";
  public static const KONST:String = "KONST";
  public static function greet():String { return "HI"; }
}

class SubHolder extends Holder { }

function run():void {
  var c:Class = Holder;
  check(c.thing == "THING", "a static getter through a Class value is invoked, got " + c.thing);
  check(c.plain == "PLAIN", "a static var through a Class value reads its value");
  check(c.KONST == "KONST", "a static const through a Class value reads its value");
  check(c.greet() == "HI", "a static method through a Class value is callable");

  // An inherited static resolves through the subclass's Class value as well.
  var s:Class = SubHolder;
  check(s.thing == "THING", "an inherited static getter resolves through the subclass Class value");

  // A name that is not a static member reads undefined (AIR does not throw here).
  var u:* = c.nonexistent;
  check(u == null, "an unknown name on a Class value reads undefined");

  // A BUILT-IN class's Class value reaches its static getter -- the exact path
  // `myClass.nativeApplication` takes.
  var nc:Class = NativeApplication;
  var app:Object = nc.nativeApplication;
  check(app != null, "a built-in static getter resolves through a Class value");
  check(app == NativeApplication.nativeApplication, "the built-in singleton identity is preserved");
}

run();
trace("class-static-member: ok");
