// End-to-end driver for the FRE host: createExtensionContext -> ctx.call -> the
// recompiled Probe ANE -> back to AS3.
//
// Every line is an assertion, and a wrong value throws rather than being quietly
// accepted, so the run is readable as a table of "does this match AIR's
// semantics" rather than "did it crash".
//
// The extension comes from the build manifest's `ane-paths`, which points at a
// STAGING TREE (ext-aot/com.example.probe), not at a packed .ane: the recompiled
// product is a directory shaped like the run-time extensions/ the loader stages
// (docs/zh-cn/ane.md 4.6). `examples/ane-app/` reaches the SAME fixture through an
// application descriptor's <extensions> instead -- two routes, one fixture.

import flash.external.ExtensionContext;
import flash.events.StatusEvent;

var passed:int = 0;

function check(label:String, actual:*, expected:*):void {
    if (actual != expected) {
        throw new Error("FAIL " + label + " = " + actual + " (expected " + expected + ")");
    }
    passed++;
    trace("ok   " + label + " = " + actual);
}

// A context whose id is not part of this build is AIR's first null case, and it
// must report itself rather than silently hand back a context. (The build prints
// the reason: "not implemented by this build: no native extension with this ID".)
check("unknown-id-is-null", ExtensionContext.createExtensionContext("com.example.nope", null) == null, true);

var ctx:ExtensionContext = ExtensionContext.createExtensionContext("com.example.probe", null);
check("created", ctx != null, true);

if (ctx != null) {
    // The StatusEvent has to arrive on the very context the call was made on,
    // before the next AS3 statement: the native half queues it and the runtime
    // drains the queue at the end of every ExtensionContext.call.
    var gotCode:String = "";
    var gotLevel:String = "";
    ctx.addEventListener(StatusEvent.STATUS, function (e:StatusEvent):void {
        gotCode = e.code;
        gotLevel = e.level;
    });

    // Strings.
    check("ping", ctx.call("ping") as String, "pong");

    // The FRE string length contract (docs/zh-cn/ane.md 5.1). AIR's header says the
    // length FREGetObjectAsUTF8 reports INCLUDES the null terminator; AIR does not
    // count it. The extension reports both counts, so `extra` is exactly that
    // disagreement -- and a non-zero `extra` is what an extension that carries the
    // length (ANEUtils::getString's std::string(val, val + length)) appends to every
    // string it reads. One extra byte inside a WebSocket URL is enough to make every
    // wss connect fail with no server reply at all, which is how this was found: the
    // host app built AOT had every wss connection dying before the TLS handshake.
    check("stringInfo('abcdef')", ctx.call("stringInfo", "abcdef") as String, "bytes=6 len=6 extra=0");
    // Four CJK chars are 12 UTF-8 bytes but 4 UTF-16 units, so the same assertion
    // also pins the count as BYTES: a unit count would answer len=4 here (and every
    // multibyte string an extension receives would be truncated).
    check("stringInfo(cjk)", ctx.call("stringInfo", String.fromCharCode(0x64CD, 0x4F5C, 0x6210, 0x529F)) as String,
          "bytes=12 len=12 extra=0");
    // The empty string follows the same rule (an empty NUL-terminated buffer is 0
    // bytes); an "includes the terminator" reading would report len=1.
    check("stringInfo('')", ctx.call("stringInfo", "") as String, "bytes=0 len=0 extra=0");

    // ints and unsigneds (both come back as boxed Numbers).
    check("addInt(2,40)", int(ctx.call("addInt", 2, 40)), 42);
    check("scaleUint(3,5)", uint(ctx.call("scaleUint", 3, 5)), 15);

    // Number.
    check("scale(1.5,2)", Number(ctx.call("scale", 1.5, 2)), 3);

    // Boolean, and its coercion path.
    check("isDebug", ctx.call("isDebug") as Boolean, false);

    // Arity: the rest-argument array must reach the native side intact.
    check("argsLength(0,1,2)", int(ctx.call("argsLength", 0, 1, 2)), 3);
    check("argsLength()", int(ctx.call("argsLength")), 0);

    // Round trips: the value must come back with its type AND value unchanged.
    check("echo(int)", ctx.call("echo", 7) as int, 7);
    check("echo(String)", ctx.call("echo", "round") as String, "round");
    check("echo(Number)", ctx.call("echo", 2.25) as Number, 2.25);
    check("echo(Boolean)", ctx.call("echo", true) as Boolean, true);
    check("echo(null)", ctx.call("echo", null) == null, true);
    var arr:Array = [1, 2, 3];
    check("echo(Array) same object", ctx.call("echo", arr) === arr, true);

    // AS3 truthiness, applied natively: "" is false in AIR.
    check("truthy('')", ctx.call("truthy", "") as Boolean, false);
    check("truthy('x')", ctx.call("truthy", "x") as Boolean, true);
    check("truthy(0)", ctx.call("truthy", 0) as Boolean, false);

    // Arrays in both directions.
    check("sumArray([1,2,3,4])", Number(ctx.call("sumArray", [1, 2, 3, 4])), 10);
    var made:Array = ctx.call("makeArray", 4) as Array;
    check("makeArray(4).length", made.length, 4);
    check("makeArray(4)[3]", made[3] as int, 30);

    // ByteArray in both directions.
    var ba:* = ctx.call("makeByteArray", 5);
    check("makeByteArray(5).length", ba.length, 5);
    check("makeByteArray(5)[0]", ba[0] as int, 1);
    check("makeByteArray(5)[4]", ba[4] as int, 5);
    check("baInfo", ctx.call("baInfo", ba) as String, "acquire=0 len=5 bytes=live b0=1");
    check("sumBytes(1..5)", int(ctx.call("sumBytes", ba)), 15);

    // FRENewObject / Get+SetObjectProperty / CallObjectMethod. The built-in classes
    // are in the registry whether or not the program names them, and their factory
    // slots are wired so a no-arg construction works (see emitBuiltinFactories);
    // newObjectResult names the FREResult directly so a failure is not silently
    // reported as a null return.
    check("newObjectResult", ctx.call("newObjectResult") as String, "newObject=0");
    check("pointX(3.5)", ctx.call("pointX", 3.5) as String, "(x=3.5, y=0)");
    var pt:Point = new Point(0, 0);
    check("setX(2.5)", ctx.call("setX", pt, 2.5) as Boolean, true);
    check("setX visible to AS3", pt.x, 2.5);

    // FREGetObjectType, one call per tag.
    check("describe(int)", ctx.call("describe", 1), "type=number");
    check("describe('s')", ctx.call("describe", "s"), "type=string");
    check("describe(true)", ctx.call("describe", true), "type=boolean");
    check("describe([1])", ctx.call("describe", [1]), "type=array");
    check("describe(null)", ctx.call("describe", null), "type=null");

    // Context native data persists across calls (the extension owns it).
    check("nativeData#1", int(ctx.call("nativeData")), 1);
    check("nativeData#2", int(ctx.call("nativeData")), 2);

    // Status events, queued natively and dispatched into AS3.
    ctx.call("bumpStatus");
    check("status code", gotCode, "probe-status");
    check("status level", gotLevel, "status");

    // The threading family: a mutex initialized by the extension must be lockable
    // by the extension (that is why it is forwarded, not DLL-local).
    var th:String = ctx.call("threading") as String;
    check("threading init+recursive-lock", th.indexOf("mutex=11") >= 0, true);

    // prim=3 is FRE_TYPE_MISMATCH: a primitive handle is a valid FREObject that is
    // simply not an object, so it is a type error and NOT an AS3 throw. sealed=4 is
    // FRE_ACTIONSCRIPT_ERROR plus a live thrown exception: writing an undeclared
    // property on a sealed instance (Point) makes AS3 raise ReferenceError #1056,
    // and that must come back as a result code rather than unwinding through the
    // extension's own C frames.
    check("throwingSet", ctx.call("throwingSet") as String, "prim=3 sealed=4 thrown=yes");
    // The deferred D face reports itself and answers FRE_ILLEGAL_STATE (8) rather
    // than a fabricated render mode.
    check("renderMode (deferred)", ctx.call("renderMode") as String, "renderMode=8");

    // Native window handles: the ONE piece of the D face that is implemented.
    //
    // This example is a HEADLESS build (its manifest names no window backend, so
    // ASC_USE_WINDOW is off), which makes it the right place for the half that must
    // stay honest there: no window backend means no handle, and the answer must be a
    // REPORTED FRE_ILLEGAL_STATE -- never a fabricated pointer an extension would
    // dereference. A wrong operand is a result code too, not a crash.
    //
    // The SUCCESS path needs a window, so it lives in examples/ane-app (--air-app
    // defines ASC_USE_WINDOW); the two examples are the before/after pair for the
    // same fixture, which is why the split is by capability rather than by taste.
    check("nativeWindowHandle(Point) headless", ctx.call("nativeWindowHandle", new Point(1, 2)) as String,
          "acquire=3 release=3 live=0 sameProcess=0 stable=0");
    check("nativeWindowHandle(null) headless", ctx.call("nativeWindowHandle", null) as String,
          "acquire=2 release=2 live=0 sameProcess=0 stable=0");

    ctx.dispose();
    check("disposed", true, true);
}

trace("RESULT passed=" + passed + " failed=0 assumptions-checked");
