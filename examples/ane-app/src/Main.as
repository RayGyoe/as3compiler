// Main.as — the document class of an AIR app that calls a native extension, built
// and run the way a user builds one: `--air-app ane-app.xml`.
//
// The point of this example, next to examples/ane/ (whose driver.as asserts the
// whole FRE surface through a plain --manifest build), is the DESCRIPTOR path:
//
//   <extensions><extensionID>com.example.probe</extensionID></extensions>
//
//   -> --air-app resolves that id over the app directory's ext-aot/ (the staging
//      tree examples/ane/build-ane.bat writes), then lib/, then ext-folder/
//   -> the manifest records the resolved path in `ane-paths`, which is what turns
//      --ane on and makes the generated C carry as_ane_descs[]
//   -> the build stages the library as <out>/extensions/com.example.probe/<platform>/
//   -> this class creates a context for it and calls into the native code.
//
// Every assertion below crosses that boundary. If any link in the chain is broken
// the value is wrong or the context is null, so the example FAILS LOUDLY instead of
// silently exercising nothing -- which is the failure mode this arrangement makes
// easy (see docs/zh-cn/ane.md §4.6).
//
// The class must be a DisplayObject (AIR's rule for a document class: the runtime
// addChild()s it onto the stage), so it extends Sprite. It is also why a build that
// links the offscreen path still needs to be a real display list.
//
// Needs the FRE host library (lib/bin/windows-x64/asaot.dll) and the fixture tree
// next to this example; the test suite skips the unit and says why when it has
// neither.
package aneapp {
    import flash.display.Sprite;
    import flash.events.StatusEvent;
    import flash.external.ExtensionContext;

    public class Main extends Sprite {
        private var passed:int = 0;

        private function check(label:String, actual:*, expected:*):void {
            if (actual != expected) {
                throw new Error("FAIL " + label + " = " + actual + " (expected " + expected + ")");
            }
            passed++;
            trace("ok   " + label + " = " + actual);
        }

        public function Main() {
            // An id this build does not carry: AIR answers null (and says so on
            // stderr). Asserting it first proves the non-null result below is not
            // "createExtensionContext returns something for anything".
            check("unknown-id-is-null",
                  ExtensionContext.createExtensionContext("com.example.nope", null) == null, true);

            // The id the descriptor declared. This is the resolution under test:
            // the same call under adl reads the packed .ane in lib/, here it reads
            // the recompiled tree in ext-aot/, and neither knows about the other.
            var ctx:ExtensionContext = ExtensionContext.createExtensionContext("com.example.probe", null);
            check("declared-id-resolves", ctx != null, true);

            // Status events are queued natively and pumped into AS3 by the host at
            // the end of each call, so the listener must be attached beforehand.
            var gotCode:String = "";
            ctx.addEventListener(StatusEvent.STATUS, function (e:StatusEvent):void {
                gotCode = e.code;
            });

            // A round trip: native code produced this string.
            check("ping", ctx.call("ping") as String, "pong");
            check("addInt(2,40)", int(ctx.call("addInt", 2, 40)), 42);

            // The extension's own state, which only a real context has: the first
            // call sees 0 and the second sees 1. A fabricated context cannot fake it.
            check("nativeData#1", int(ctx.call("nativeData")), 1);
            check("nativeData#2", int(ctx.call("nativeData")), 2);

            // AS3 truthiness applied by native code: `""` is false.
            check("truthy('')", ctx.call("truthy", "") as Boolean, false);

            ctx.call("bumpStatus");
            check("status event reached AS3", gotCode, "probe-status");

            // Disposal is real: the extension's finalizer runs here.
            ctx.dispose();
            trace("ok   disposed");

            trace("RESULT passed=" + passed + " failed=0");
        }
    }
}
