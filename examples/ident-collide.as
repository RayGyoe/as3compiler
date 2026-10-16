// Regression pin for a CODEGEN name clash (not an AIR semantics divergence): the
// generated C body plants fixed identifier spellings that AS3 source is equally
// free to use. `o` is the receiver parameter of a generated class constructor and
// `_this` the receiver of every generated instance method, so a class that
// declares a parameter/field/local named `o` used to emit C that clang rejected:
//
//   static void Widget_ctor(Widget* o) { ... Object* o = NULL; ... }
//   error: redefinition of 'o' with a different type: 'Object *' vs 'Widget *'
//
// (measured on a 7-line AIR app class -- temp/d31probe/ocollide2.as; `adl` runs
// that file fine). `cIdent` now keeps the emitter's own spellings out of the AS3
// identifier space: the source identifier is emitted as `_o` / `__this` while
// every AIR-visible behaviour -- including the REFLECTION name, which stays the
// original string -- is unchanged. Names in the tmpName() family (`_i0`, `_once3`)
// are reserved the same way.
class Widget {
  public var o:int;                 // field spelled like the receiver parameter
  public static var total:int = 0;

  public function Widget(o:int, _this:String) {
    this.o = o;
    total = o + _this.length;
  }

  public function add(o:int, _this:int):int {
    return o + _this;
  }

  public function locals():int {
    var o:Object = { a: 3 };        // local spelled like the receiver parameter
    var _this:int = 4;              // local spelled like the method receiver
    var _i0:int = 5;                // local spelled like a tmpName() temporary
    return o.a + _this + _i0;
  }

  public function nested():int {
    var o:int = 6;                  // captured by the closure below
    var f:Function = function():int { return o * 7; };
    return f();
  }
}

// A method may itself be named `o` (distinct C spelling: `Helper_o`).
class Helper {
  public function o():int { return 9; }
  public function twice(o:int):int { return o + o(); }
}

function assertEq(label:String, got:int, want:int):void {
  if (got !== want) throw new Error(label + ": got " + got + ", want " + want);
}

var w:Widget = new Widget(5, "abc");
assertEq("ctor param o / static total", Widget.total, 8);
assertEq("field o", w.o, 5);
assertEq("method add(o, _this)", w.add(2, 3), 5);
assertEq("locals named o/_this/_i0", w.locals(), 12);
assertEq("closure capturing a local named o", w.nested(), 42);
// The C identifier is renamed, but the AS3 reflection name must NOT drift: a
// dynamic read of "o" has to keep finding the field.
assertEq('dynamic w["o"] finds the field', w["o"] as int, 5);
// AIR's for-in over a SEALED class instance yields no keys at all (measured on
// adl 51.4.1: a two-field sealed class reported `forin=[]`); the renamed C
// identifier must not leak into enumeration either way.
var keys:String = "";
for (var k:String in w) keys += k + ",";
if (keys !== "") throw new Error('for-in over a sealed instance reported: ' + keys);

var h:Helper = new Helper();
assertEq("method named o", h.o(), 9);
assertEq("param named o", h.twice(4), 13);

// A local named like a generated temp must not collide with the temp itself, and
// a hoisted self-modifying assignment (which creates `_once<N>`) must still work
// in the same scope.
function hoistAndLocal():int {
  var _once0:int = 1;
  var t:int = 10;
  var c:int = 2 * (t += 5);
  return _once0 + t + c;
}
assertEq("tmpName-shaped local + hoisted assign", hoistAndLocal(), 1 + 15 + 30);

trace("ident-collide: emitter-planted C names do not collide with AS3 identifiers OK");
