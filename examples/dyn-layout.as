// Regression for 阶段二百三十五 (inheritance-flattened runtime slots).
//
// A class that extends a DYNAMIC class inherits the `_dyn` slot table at the BASE
// class's offset. The emitter used to append a fresh `as_object* _dyn` at the end
// of every class in the chain instead, which left the inherited slot's bytes unused
// and handed them to the subclass's FIRST own field: DynBase_ctor's
// `_dyn = new Object()` then wrote a plain Object into that field. A field with an
// initializer was masked (the initializer runs after super()), so the aliasing only
// showed up on members that are expected to START as null -- exactly the
// `if (!popInfoView) ... else toggle` shape that killed the AOT host: there
// HeaderView.popInfoView shared mheader._dyn (0x130) and the info button's toggle
// dispatched through _as_object_vt slot 0x13c == 1 (execute AV at 0x1).
dynamic class DynBase {
    public var baseField:int = 11;

    public function DynBase() {
        this.dynamicExtra = 7;
    }
}

class DynSub extends DynBase {
    // No initializer: must be null until AS3 assigns it.
    public var lazy:Object;
    public var lazyInt:int;
    public var baseField2:int;

    public function DynSub() {
        super();
    }

    public function describe():String {
        return "lazy=" + (lazy == null ? "null" : "CLOBBERED")
            + " lazyInt=" + lazyInt
            + " baseField2=" + (baseField2 == 0 ? "0" : "CLOBBERED");
    }
}

var d:DynSub = new DynSub();
trace("baseField=" + d.baseField + " dynamicExtra=" + d.dynamicExtra + " " + d.describe());
if (d.lazy == null && d.lazyInt == 0 && d.baseField2 == 0 && d.baseField == 11) {
    trace("dyn-layout ok");
} else {
    trace("dyn-layout BROKEN");
}