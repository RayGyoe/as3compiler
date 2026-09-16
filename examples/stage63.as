// stage63.as — flash.net / flash.ui (v0.3.64): URLRequest / URLLoader /
// Keyboard / Mouse.
//
// URLLoader.load() performs a synchronous whole-file read (the URL is treated as
// a local filesystem path): COMPLETE is dispatched on success, IOErrorEvent.IO_ERROR
// on failure. data holds the file text (malloc-backed, not GC-tracked). Socket /
// Sound / SoundChannel / Video / ContextMenu / URLVariables are deferred.
// Keyboard is a static key-code constant table; Mouse is static hide/show plus a
// read-only cursor flag.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- URLRequest: value bundle + defaults ---
var req:URLRequest = new URLRequest("data.txt");
check(req.url == "data.txt", "URLRequest url stored");
check(req.method == "GET", "URLRequest method defaults to GET");
check(req.data == null, "URLRequest data defaults to null");
check(req.contentType == null, "URLRequest contentType defaults to null");
req.method = "POST";
check(req.method == "POST", "URLRequest method writable");

// --- URLLoader: successful synchronous file read ---
var loader:URLLoader = new URLLoader();
check(loader is URLLoader && loader is EventDispatcher, "URLLoader is EventDispatcher");
check(loader.data == null, "URLLoader data starts null");

var done:Boolean = false;
function onComplete(e:Event):void { done = true; }
loader.addEventListener(Event.COMPLETE, onComplete);
loader.load(new URLRequest("examples/stage63.as"));
check(done, "load dispatches COMPLETE on success");
check(loader.data != null, "load fills data");
check(loader.data.indexOf("stage63") >= 0, "data contains file content");

// --- URLLoader: failure path dispatches IO_ERROR ---
var bad:URLLoader = new URLLoader();
var failed:Boolean = false;
function onError(e:Event):void { failed = true; }
bad.addEventListener(IOErrorEvent.IO_ERROR, onError);
bad.load(new URLRequest("/nonexistent/does/not/exist.txt"));
check(failed, "load dispatches IO_ERROR on failure");
check(bad.data == null, "failed load leaves data null");

// --- Keyboard: static key-code constants + isAccessible ---
check(Keyboard.A == 65 && Keyboard.Z == 90, "Keyboard A/Z key codes");
check(Keyboard.NUMBER_0 == 48 && Keyboard.NUMBER_9 == 57, "Keyboard 0/9 key codes");
check(Keyboard.SPACE == 32 && Keyboard.ENTER == 13, "Keyboard SPACE/ENTER key codes");
check(Keyboard.LEFT == 37 && Keyboard.UP == 38 && Keyboard.RIGHT == 39 && Keyboard.DOWN == 40, "Keyboard arrow key codes");
check(Keyboard.isAccessible == true, "Keyboard.isAccessible true");

// --- Mouse: static hide/show + cursor/supportsCursor ---
Mouse.hide();
Mouse.show();
check(Mouse.cursor == "auto", "Mouse.cursor default auto");
check(Mouse.supportsCursor == true, "Mouse.supportsCursor true");
check(Mouse.supportsNativeCursor == true, "Mouse.supportsNativeCursor true");

trace("stage63: all flash.net/flash.ui assertions passed");
