// Main.as — the document class of an AIR app that calls a native extension, built
// and run the way a user builds one: `--air-app ane-app.xml`.
//
// The point of this example, next to examples/ane/ (whose driver.as asserts the
// whole FRE surface through a plain --manifest build), is the DESCRIPTOR path:
//
//   <extensions><extensionID>com.example.probe</extensionID></extensions>
//
//   -> --air-app resolves that id over the app directory's ext-aot/ (the staging
//      tree examples/ane/build-ane.bat or build-ane.sh writes), then lib/, then
//      ext-folder/
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
    import flash.display.NativeWindow;
    import flash.display.NativeWindowInitOptions;
    import flash.desktop.NativeApplication;
    import flash.display.Bitmap;
    import flash.display.BitmapData;
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.events.StatusEvent;
    import flash.external.ExtensionContext;

    public class Main extends Sprite {
        private var passed:int = 0;
        // Held in a field because the native-window assertions run on the first
        // frame, not in the constructor -- see the handler below.
        private var ctx:ExtensionContext;

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
            ctx = ExtensionContext.createExtensionContext("com.example.probe", null);
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

            // Native window handles -- the one D-face pair that is implemented, and
            // the reason THIS example is where the success path is asserted: it is
            // windowed (--air-app defines ASC_USE_WINDOW), whereas examples/ane is a
            // headless build that can only assert the refusal.
            //
            // The extension does not just return "non-null": it asks the OS whether
            // the handle is a window of THIS process and acquires twice to prove the
            // same slot answers the same object, so a fabricated or mis-slotted
            // handle fails here rather than inside a real ANE.
            check("nativeWindowHandle(NativeWindow)",
                  ctx.call("nativeWindowHandle", new NativeWindow(new NativeWindowInitOptions())) as String,
                  "acquire=0 release=0 live=1 sameProcess=1 stable=1");
            // stage.nativeWindow is the case a video ANE actually asks for, and it
            // is checked on the FIRST FRAME rather than here -- see onFirstFrame.
            stage.addEventListener(Event.ENTER_FRAME, onFirstFrame);

            // BitmapData handoff -- the OTHER half of the FRE pair, the one that needs
            // a renderer and therefore lives in this windowed example.
            //
            // Writing through bits32 is only half the contract; the frame has to reach
            // the screen. Our BitmapData keeps a cached SkImage view keyed on a version
            // counter, so a host that hands out the pixel pointer WITHOUT invalidating
            // it draws the FIRST frame forever -- which is exactly the "video freezes on
            // frame 1" failure a video ANE hits. Two frames, two colours, drawn through
            // a real Bitmap: the second readback must differ from the first.
            var src:BitmapData = new BitmapData(16, 8, false, 0);
            var shot:BitmapData = new BitmapData(16, 8, false, 0);
            var bmp:Bitmap = new Bitmap(src);
            ctx.call("writeBitmapData", src, uint(0xFFFF0000));
            shot.draw(bmp);
            check("bitmapData frame1 visible", shot.getPixel32(8, 4), 0xFFFF0000);
            ctx.call("writeBitmapData", src, uint(0xFF0000FF));
            shot.draw(bmp);
            check("bitmapData frame2 replaces frame1", shot.getPixel32(8, 4), 0xFF0000FF);
            // And through the readback path AS3 owns, so a stride or geometry defect
            // cannot hide behind the renderer's own scaling.
            check("bitmapData pixels as AS3 sees them", src.getPixel32(15, 7), 0xFF0000FF);

            ctx.call("bumpStatus");
            check("status event reached AS3", gotCode, "probe-status");

        }

        // The initial window is opened AFTER the document class is constructed in
        // this runtime (Stage.showWindow does it, then blocks on the event loop), so
        // inside the constructor slot 0 has no OS window yet and the entry point
        // correctly answers FRE_ILLEGAL_STATE. AIR's ordering is the opposite one
        // (the window exists before the constructor), and that difference is
        // registered in docs/zh-cn/ane.md section 5 -- asserting here is asserting
        // what BOTH runtimes agree on: by the first frame a window exists.
        private function onFirstFrame(e:Event):void {
            stage.removeEventListener(Event.ENTER_FRAME, onFirstFrame);
            check("nativeWindowHandle(stage)",
                  ctx.call("nativeWindowHandle", stage.nativeWindow) as String,
                  "acquire=0 release=0 live=1 sameProcess=1 stable=1");

            // Disposal is real: the extension's finalizer runs here.
            ctx.dispose();
            trace("ok   disposed");

            trace("RESULT passed=" + passed + " failed=0");

            // The window is real, so the event loop is real: end it here or the run
            // never returns. That self-exit is the whole cost of being windowed, and
            // it buys the only end-to-end proof that a native HANDLE exists.
            NativeApplication.nativeApplication.exit();
        }
    }
}
