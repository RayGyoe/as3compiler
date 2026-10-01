// async-io.as — asynchronous IO contract (stage 89-45).
//
// Stage 89-45 turned the file helpers into real async IO: the read (and, for
// Loader, the image decode) runs as a job off the AS3 thread, the payload is
// staged outside the GC heap, and a finish thunk publishes it back to AS3 at the
// next frame boundary (headless examples pump that boundary with tickTimers()).
// The assertions below pin the user-visible AIR contract that follows from it:
//
//   1. The payload is NOT visible between load() and the terminal event —
//      URLLoader.data / Loader.content stay null and bytesLoaded/bytesTotal stay
//      0 (AIR: LoaderInfo.complete is dispatched "when data has loaded
//      successfully", i.e. data arrives WITH the event, not before it).
//   2. PROGRESS precedes COMPLETE and carries the byte counts.
//   3. Several requests can be in flight at once, and calling load() again on a
//      target that is still loading supersedes the in-flight job (AIR restarts
//      the load), so the stale job never dispatches an event.
//
// Image *decoding* needs the Skia backend; a pure-C build links no decoder and
// therefore reports an undecodable payload as IO_ERROR (#2124 "Loaded file is an
// unknown type") rather than publishing a silently empty Bitmap. The decoded
// content path itself is covered by the Skia-backed acceptance demo
// (examples/air-starling-demo). FileStream.openAsync's PROGRESS/COMPLETE is
// asserted in stage64.as.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. URLLoader (text): payload invisible until COMPLETE, PROGRESS first ---
var text:URLLoader = new URLLoader();
var seq:String = "";
var textProgress:Boolean = false;
var textComplete:Boolean = false;
var textLoaded:int = 0;
var textTotal:int = 0;
function onTextProgress(e:ProgressEvent):void {
    textProgress = true;
    textLoaded = e.bytesLoaded;
    textTotal = e.bytesTotal;
    seq += "progress,";
}
function onTextComplete(e:Event):void { textComplete = true; seq += "complete,"; }
text.addEventListener(ProgressEvent.PROGRESS, onTextProgress);
text.addEventListener(Event.COMPLETE, onTextComplete);
text.load(new URLRequest("examples/stage63.as"));

check(text.data == null, "URLLoader.data stays null between load() and COMPLETE");
check(!textComplete && !textProgress, "URLLoader dispatches no event synchronously");
check(textTotal == 0, "URLLoader.bytesTotal is 0 before the first PROGRESS");
tickTimers();
check(textComplete, "URLLoader dispatches COMPLETE on the next tick");
check(text.data != null, "URLLoader.data is published at COMPLETE");
check(seq == "progress,complete,", "PROGRESS precedes COMPLETE");
check(textLoaded == textTotal && textTotal > 0, "PROGRESS reports loaded == total > 0");
var textStr:String = text.data as String;
check(textStr.length == textTotal, "text payload length matches the reported byte count");
check(textStr.indexOf("stage63") >= 0, "text payload is the file that was requested");

// --- 2. URLLoader (binary): data is a ByteArray with the exact byte count ---
var bin:URLLoader = new URLLoader();
bin.dataFormat = URLLoaderDataFormat.BINARY;
var binComplete:Boolean = false;
var binProgress:Boolean = false;
var binTotal:int = 0;
function onBinProgress(e:ProgressEvent):void { binProgress = true; binTotal = e.bytesTotal; }
function onBinComplete(e:Event):void { binComplete = true; }
bin.addEventListener(ProgressEvent.PROGRESS, onBinProgress);
bin.addEventListener(Event.COMPLETE, onBinComplete);
bin.load(new URLRequest("examples/async-io.as"));
check(bin.data == null, "binary load keeps data null until COMPLETE");
tickTimers();
check(binComplete && binProgress, "binary load dispatches PROGRESS then COMPLETE");
var payload:ByteArray = bin.data as ByteArray;
check(payload != null, "BINARY dataFormat yields a ByteArray");
check(payload.length == binTotal && binTotal > 0, "ByteArray length matches the reported byte count");

// --- 3. Several requests in flight at once ---
// The five files have different sizes and each mentions its own name, so a
// payload published to the wrong target (or a stale payload kept from a previous
// load) would fail one of the checks below.
var paths:Array = ["examples/stage62.as", "examples/stage63.as", "examples/stage64.as",
                   "examples/stage65.as", "examples/stage66.as"];
var names:Array = ["stage62", "stage63", "stage64", "stage65", "stage66"];
var conc:Array = [];
var concTotals:Array = [0, 0, 0, 0, 0];
var concDone:int = 0;
function onConcComplete(e:Event):void { concDone++; }
// URLLoader itself has no bytesTotal in this subset, so the per-request byte
// count is recorded from the PROGRESS event and matched against the payload the
// same request published: a payload delivered to the wrong target would show up
// as a length mismatch here.
function onConcProgress(e:ProgressEvent):void {
    var t:URLLoader = e.target as URLLoader;
    for (var k:int = 0; k < conc.length; k++) {
        if (conc[k] == t) concTotals[k] = e.bytesTotal;
    }
}
for (var i:int = 0; i < paths.length; i++) {
    var c:URLLoader = new URLLoader();
    c.addEventListener(Event.COMPLETE, onConcComplete);
    c.addEventListener(ProgressEvent.PROGRESS, onConcProgress);
    c.load(new URLRequest(paths[i]));
    conc.push(c);
}
check(concDone == 0, "no request completes before the frame boundary");
tickTimers();
check(concDone == paths.length, "all " + paths.length + " in-flight requests complete in one boundary");
for (var j:int = 0; j < conc.length; j++) {
    var cl:URLLoader = conc[j] as URLLoader;
    check(cl.data != null, "concurrent request " + j + " published its data");
    var cs:String = cl.data as String;
    check(cs.indexOf(names[j]) >= 0, "concurrent request " + j + " got its own file, not another one's");
    check(cs.length == concTotals[j] && concTotals[j] > 0, "concurrent request " + j + " reports its own byte count");
}

// --- 4. A repeated load() supersedes the request in flight ---
var sup:URLLoader = new URLLoader();
var supCount:int = 0;
function onSupComplete(e:Event):void { supCount++; }
sup.addEventListener(Event.COMPLETE, onSupComplete);
sup.load(new URLRequest("examples/stage62.as"));
sup.load(new URLRequest("examples/stage65.as"));
check(supCount == 0, "supersede: nothing completes synchronously");
tickTimers();
check(supCount == 1, "supersede: only the newest load dispatches COMPLETE");
var supStr:String = sup.data as String;
check(supStr.indexOf("stage65") >= 0, "supersede: the newest URL is the one that lands");

// --- 5. A failing load reports IO_ERROR, never a stale payload ---
// A successful load first, so the failure has something stale to clear.
var fail:URLLoader = new URLLoader();
var failState:String = "";
function onFailComplete(e:Event):void { failState = "complete"; }
function onFailError(e:IOErrorEvent):void { failState = "ioError:" + e.text; }
fail.addEventListener(Event.COMPLETE, onFailComplete);
fail.addEventListener(IOErrorEvent.IO_ERROR, onFailError);
fail.load(new URLRequest("examples/stage62.as"));
tickTimers();
check(failState == "complete" && fail.data != null, "the first load of the failing loader succeeds");
fail.load(new URLRequest("definitely/not/a/real/file.bin"));
check(fail.data == null, "a new load clears the previous payload immediately");
check(failState == "complete", "the failed load dispatches no event synchronously");
tickTimers();
check(failState.indexOf("ioError:") == 0, "an unreadable URL reports IO_ERROR on the next tick");
check(failState != "complete", "an unreadable URL never reports COMPLETE");
check(fail.data != null && fail.data == "", "a failed load publishes an EMPTY value, not null (AIR: data=String len=0)");

// --- 6. Loader.loadBytes: reads the payload, INIT is synchronous, decode may fail ---
var ldr:Loader = new Loader();
var ldrInit:Boolean = false;
var ldrComplete:Boolean = false;
var ldrError:Boolean = false;
function onLdrInit(e:Event):void { ldrInit = true; }
function onLdrComplete(e:Event):void { ldrComplete = true; }
function onLdrError(e:IOErrorEvent):void { ldrError = true; }
ldr.contentLoaderInfo.addEventListener(LoaderInfo.INIT, onLdrInit);
ldr.contentLoaderInfo.addEventListener(LoaderInfo.COMPLETE, onLdrComplete);
ldr.contentLoaderInfo.addEventListener(LoaderInfo.IO_ERROR, onLdrError);
ldr.loadBytes(payload);
check(ldrInit, "loadBytes dispatches INIT synchronously");
check(!ldrComplete && !ldrError, "loadBytes dispatches no terminal event synchronously");
check(ldr.content == null, "loadBytes leaves content null until the terminal event");
tickTimers();
check(!(ldrComplete && ldrError), "loadBytes never dispatches both COMPLETE and IO_ERROR");
check(ldrComplete || ldrError, "loadBytes dispatches exactly one terminal event on the next tick");
check(ldr.contentLoaderInfo.bytesTotal == payload.length, "loadBytes reports the payload byte count");
// The payload is ActionScript source, not an image: it cannot be decoded in any
// build, so AIR's outcome is deterministic - IO_ERROR (#2124), and no content.
// The failure must not be papered over with an empty Bitmap, which is what the
// pre-stage-89-45 code did by falling through to a 0x0 BitmapData.
check(ldrError, "an undecodable payload reports IO_ERROR");
check(!ldrComplete, "an undecodable payload never reports COMPLETE");
check(ldr.content == null, "an undecodable payload leaves content null, not an empty Bitmap");

trace("async-io: all asynchronous IO assertions passed");