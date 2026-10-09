// Nearest-declaration member resolution: a class's OWN accessor beats an
// INHERITED FIELD of the same name.
//
// away3d's Intermediate_MD5Animation died at startup with
//   Uncaught exception: Error #1009: Cannot access a property or method of a
//   null object reference.
// Stack (lldb, `-O2`): Intermediate_MD5Animation_init/initObjects -> addChild ->
// setParent -> ObjectContainer3D_updateMouseChildren -> as_req_obj (NULL).
// The body of updateMouseChildren reads the GETTER `parent`:
//   if (_parent && !_parent._isRoot) _ancestorsAllowMouseEnabled = parent._ancestorsAllowMouseEnabled && ...
// `away3d.containers.ObjectContainer3D` declares `get parent():ObjectContainer3D`,
// but our built-in `EventDispatcher` keeps the display-list ancestor link in a
// stored slot that is ALSO named `parent` (AIR's EventDispatcher has no `parent`
// at all, so the two never meet there). The flattened field map was consulted
// before accessors, the inherited slot won -- and it is never assigned on an
// away3d ObjectContainer3D, whose own graph uses `_parent` -- so `parent` read
// NULL and the #1009 guard fired. It only bites when a container is parented to a
// NON-root container (`redLight.addChild(new Sprite3D(...))`), which is why the
// sibling demos that only ever add to the root scene never hit it.
//
// AS3 settles an instance-member reference by the NEAREST declaration in the
// superclass chain, so an own getter must win over an ancestor's field. Cases 1-2
// pin that; cases 3-5 pin the neighbouring rules that must NOT change: an
// unshadowed inherited field still reads, and a nearer SETTER-ONLY override (our
// built-ins keep AIR's accessor PAIRS as stored fields, so there is no inherited
// getter to fall back to) must not make a read of the name disappear.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// The away3d shape, minimized: a base with no `parent` of its own, and a leaf
// whose own `get parent()` must shadow the inherited EventDispatcher slot. AIR
// agrees -- it has no `parent` on EventDispatcher, so this getter is a fresh
// definition and reading it is unremarkable there.
class ShadowBase extends EventDispatcher {
  public function tag():String { return "base"; }
}

class ShadowSub extends ShadowBase {
  public function get parent():String { return "shadow"; }
}

// A deeper subclass that does NOT redeclare the getter: the inherited accessor
// must still win over the inherited field (away3d reads `parent` on subclasses of
// ObjectContainer3D constantly -- Entity, Mesh, SegmentSet, ...).
class ShadowDeeper extends ShadowSub {
}

// --- 1) an own getter shadows the inherited field ---
var sub:ShadowSub = new ShadowSub();
check(sub.parent == "shadow", "own getter must shadow the inherited `parent` field");
check(sub.tag() == "base", "the rest of the inherited surface still resolves");

// --- 2) the inherited getter reaches subclasses that do not redeclare it ---
var deeper:ShadowDeeper = new ShadowDeeper();
check(deeper.parent == "shadow", "an inherited getter still shadows the inherited field");

// --- 3) unshadowed: the inherited field itself still reads and writes ---
class PlainSub extends EventDispatcher {
  public function get answer():int { return 42; }
}
var plain:PlainSub = new PlainSub();
check(plain.answer == 42, "an own getter with no inherited field of that name");

var sprite:Sprite = new Sprite();
check(sprite.name == null, "a fresh DisplayObject name read");
sprite.name = "kid";
check(sprite.name == "kid", "an unshadowed inherited field still writes and reads back");
check(sprite.parent == null, "a fresh Sprite has no parent");

// --- 4) the display-list slot is still the same storage the runtime uses ---
var holder:Sprite = new Sprite();
var child:Sprite = new Sprite();
holder.addChild(child);
check(child.parent == holder, "addChild stores into the inherited parent slot");

// --- 5) a nearer setter-only override must not hide the stored field on a READ ---
// This is away3d's View3D verbatim (`override public function set x(value:Number)`
// whose body reads `x`); the read must reach DisplayObject's stored `y`, not
// vanish. Without the setter exclusion this shape fails to COMPILE
// ("undefined variable 'y' in class SetterOnlySub"), which is how the first cut of
// the fix was caught.
class SetterOnlySub extends Sprite {
  public var seen:Number = -1;
  override public function set y(value:Number):void {
    if (y == value) return;
    seen = value;
    super.y = value;
  }
}
var setterOnly:SetterOnlySub = new SetterOnlySub();
setterOnly.y = 7;
check(setterOnly.seen == 7, "a nearer setter still governs writes");
check(setterOnly.y == 7, "a read beside a setter-only override still hits the stored field");
setterOnly.y = 7;
check(setterOnly.seen == 7, "the setter's own `y == value` read saw the stored value");

trace("member-shadow: all assertions passed");