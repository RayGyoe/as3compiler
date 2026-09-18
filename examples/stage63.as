// stage63.as — flash.net / flash.ui (v0.3.70): URLRequest / URLLoader /
// URLVariables / Keyboard / Mouse.
//
// URLLoader.load() treats the URL as a local filesystem path and reads the file,
// but dispatches COMPLETE/IO_ERROR asynchronously on the next frame tick
// (as_set_timeout(0)) — so listeners registered after load() still fire, matching
// AIR's async contract. data is a GC-managed String (as_str_alloc, not malloc).
// URLVariables is an AS3 `dynamic class`: undeclared string-keyed properties live
// in a runtime slot table and toString() serializes them as a query string.
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

// --- URLLoader: async file read (COMPLETE on the next tick) ---
var loader:URLLoader = new URLLoader();
check(loader is URLLoader && loader is EventDispatcher, "URLLoader is EventDispatcher");
check(loader.data == null, "URLLoader data starts null");

var done:Boolean = false;
function onComplete(e:Event):void { done = true; }
loader.addEventListener(Event.COMPLETE, onComplete);
loader.load(new URLRequest("examples/stage63.as"));
check(!done, "load does not dispatch COMPLETE synchronously");
tickTimers(); // pump the deferred completion
check(done, "load dispatches COMPLETE on the next tick");
check(loader.data != null, "load fills data");
check(loader.data.indexOf("stage63") >= 0, "data contains file content");

// --- URLLoader: failure path dispatches IO_ERROR (also deferred) ---
var bad:URLLoader = new URLLoader();
var failed:Boolean = false;
function onError(e:Event):void { failed = true; }
bad.addEventListener(IOErrorEvent.IO_ERROR, onError);
bad.load(new URLRequest("/nonexistent/does/not/exist.txt"));
check(!failed, "load does not dispatch IO_ERROR synchronously");
tickTimers();
check(failed, "load dispatches IO_ERROR on the next tick");
check(bad.data == null, "failed load leaves data null");

// --- URLVariables: dynamic properties + toString serialization ---
var vars:URLVariables = new URLVariables();
vars.name = "John Doe";
vars.age = 42;
check(vars.name == "John Doe", "URLVariables dynamic string prop");
check(vars.age == 42, "URLVariables dynamic number prop");
var qs:String = vars.toString();
check(qs.indexOf("name=") >= 0, "URLVariables.toString contains key");
check(qs.indexOf("John") >= 0, "URLVariables.toString contains value");

var parsed:URLVariables = new URLVariables("a=1&b=hello");
check(parsed.a == "1", "URLVariables parses a=1");
check(parsed.b == "hello", "URLVariables parses b=hello");
check(parsed.toString().indexOf("a=") >= 0, "parsed URLVariables round-trips");

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
