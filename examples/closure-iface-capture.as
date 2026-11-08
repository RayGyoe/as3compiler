// closure-iface-capture.as — a closure capturing an **interface-typed** variable
// (compiler-gaps.md G37). An interface value is stored BY VALUE in the generated
// C as the { void* obj; <Iface>_vtable* vt; } struct (see `cTypeName`'s
// 'interface' case and `vectorElemIsPtr`, which excludes interface elements for
// the same reason), so a closure environment must treat it as a struct in three
// places:
//   1) the env field type is the struct, not a pointer;
//   2) its GC trace must reach the payload pointer -- `gc_mark_ptr((void*)e->f)`
//      over a struct is a C type error:
//        error: operand of type 'IEnv' (aka 'struct IEnv') where arithmetic or
//               pointer type is required
//   3) the env allocator's own pointer local must not be spelled after a capture
//      (a capture named `e` -- `function follow(e:IEnv)` -- used to redeclare it:
//        error: redefinition of 'e' with a different type: '_fn0_env *' vs 'IEnv')
// All three were real: the generated C did not compile, while `mxmlc`/`adl`
// accept the same program (adl 51.4.1, temp/g37/air: `mxmlc` 661-byte SWF, `adl`
// prints `start` / `cb zh-CN1` / `end` -- the same three lines section 1 asserts).
//
// The rejected-before shapes are all pinned here: interface PARAMETER capture,
// interface LOCAL capture, nested (depth-2) capture, capture that must survive a
// collection as the only reference, and a captured interface write through an
// activation cell (reference semantics).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ------------------------------------------------ 1) interface PARAMETER, named `e`
// The G37 headline shape: the closure is handed to a method of the very same
// interface variable it captures (receiver and argument depend on each other).
var paramOut:String = "";
function follow(e:IEnv):void
{
    e.subscribe(function (d:int):void { paramOut = e.locale + d; });
}
follow(new EnvImpl());
check(paramOut == "zh-CN1", "captured interface parameter must stay usable in the closure (got '" + paramOut + "')");

// ------------------------------------------------------ 2) interface LOCAL
function localReader():String
{
    var v:IEnv = new EnvImpl();
    var f:Function = function ():String { return v.locale + "/" + v.id(7); };
    return f();
}
check(localReader() == "zh-CN/id7", "captured interface local (got '" + localReader() + "')");

// ------------------------------------------- 3) depth-2 nested closure capture
function nest():Function
{
    var outer:IEnv = new EnvImpl();
    return function ():Function
    {
        var mid:IEnv = outer;
        return function (n:int):String { return mid.locale + outer.locale + n; };
    };
}
check(nest()()(5) == "zh-CNzh-CN5", "a grandchild closure must capture the interface transitively");

// ------------------------- 4) the closure env is the ONLY reference across a GC
// The env field is traced through `.obj`, so the payload must survive a
// collection that has no other root. (Structural proof that it is traced at all
// is pinned source-level in `unit: emit/ClosureIfaceCapture`; this is the
// behavioural half.)
function makeOnlyRef():Function
{
    var e:IEnv = new EnvImpl();
    return function ():String { return e.locale; };
}
var only:Function = makeOnlyRef();
System.gc();
for (var i:int = 0; i < 5000; i++) { var junk:String = "junk" + i; }
System.gc();
check(only() == "zh-CN", "a captured interface payload must survive a full collection (got '" + only() + "')");

// ------------------------------------ 5) captured interface through a cell
// A `var` local that the closure reads and the body later assigns lives in a
// shared activation cell, so the closure must observe the NEW instance.
function cellSeen():String
{
    var cur:IEnv = new EnvImpl("first");
    var f:Function = function ():String { return cur.locale; };
    cur = new EnvImpl("second");
    return f();
}
check(cellSeen() == "second", "a captured interface local is shared by reference (got '" + cellSeen() + "')");

// --------------------------------- 6) the interface capture is not a frozen copy
// Two closures over one interface variable must both see the later write, and a
// write from inside a closure must reach the enclosing body.
function shared():String
{
    var cur:IEnv = new EnvImpl("a");
    var put:Function = function ():void { cur = new EnvImpl("b"); };
    put();
    var read:Function = function ():String { return cur.locale; };
    return read();
}
check(shared() == "b", "two closures over one interface variable must share it (got '" + shared() + "')");

trace("closure-iface-capture OK");

interface IEnv { function get locale():String; function id(n:int):String; function subscribe(f:Function):void; }

class EnvImpl implements IEnv
{
    private var _tag:String;
    public function EnvImpl(t:String = "zh-CN") { _tag = t; }
    public function get locale():String { return _tag; }
    public function id(n:int):String { return "id" + n; }
    public function subscribe(f:Function):void { f(1); }
}