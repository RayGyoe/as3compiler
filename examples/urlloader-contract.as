// urlloader-contract.as — stage 89·48, phase B of docs/zh-cn/flash-net.md:
// the URLLoader CONTRACT around the existing local-file read.
//
// URLLoader in this subset still reads the URL as a filesystem path (no HTTP —
// that is phase C+ of the design doc, and it is honest about it: nothing here
// pretends to reach a network). What this example pins down is the event/state
// contract a caller actually programs against, all of which was missing or
// misleading before: the OPEN event was never dispatched, bytesLoaded/bytesTotal
// did not exist, the URLLoader(request) constructor took no argument, close() was
// an empty function, and dataFormat=VARIABLES produced a String instead of a
// URLVariables object.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- A fresh URLLoader: documented initial state ---
var l0:URLLoader = new URLLoader();
check(l0.data == null, "data starts null");
check(l0.dataFormat == "text", "dataFormat defaults to text");
check(l0.bytesLoaded == 0, "bytesLoaded starts 0");
check(l0.bytesTotal == 0, "bytesTotal starts 0");

// --- URLLoader(request) begins the load immediately, but nothing is dispatched
// synchronously: a listener registered AFTER the constructor still receives every
// event, which is the whole reason the delivery is deferred to a frame tick. ---
var l1:URLLoader = new URLLoader(new URLRequest("examples/urlloader-contract.as"));
var log:String = "";
var seenTotal:Number = -1;
function onOpen1(e:Event):void { log += "open;"; }
function onProgress1(e:ProgressEvent):void {
  log += "progress;";
  seenTotal = e.bytesTotal;
  check(e.bytesLoaded == e.bytesTotal, "PROGRESS reports loaded == total");
}
function onComplete1(e:Event):void {
  log += "complete;";
  check(l1.data != null, "COMPLETE is dispatched after data is published");
}
l1.addEventListener(Event.OPEN, onOpen1);
l1.addEventListener(ProgressEvent.PROGRESS, onProgress1);
l1.addEventListener(Event.COMPLETE, onComplete1);
check(log == "", "the constructor dispatches nothing synchronously");
check(l1.data == null, "data stays null until the load completes");
check(l1.bytesLoaded == 0 && l1.bytesTotal == 0, "byte counters read 0 while the load is in flight");

tickTimers(); // pump the deferred completion

check(log == "open;progress;complete;", "event order is OPEN -> PROGRESS -> COMPLETE");
check(seenTotal > 0, "PROGRESS carries the byte count");
check(l1.data != null, "data is published");
check(l1.data.indexOf("urlloader-contract") >= 0, "data holds the file content");
check(l1.bytesLoaded == seenTotal, "bytesLoaded is published once the load completes");
check(l1.bytesTotal == seenTotal, "bytesTotal is published once the load completes");

// --- The byte counters are documented as 0 for the whole duration of the load,
// so a PROGRESS listener reading the loader (rather than the event) sees 0. ---
check(l1.bytesTotal != 0, "…and the pair is no longer 0 after completion");

// --- close() during flight terminates the load: the pending thunk never runs, so
// no OPEN/PROGRESS/COMPLETE/IO_ERROR reaches a listener afterwards. ---
var l2:URLLoader = new URLLoader();
var log2:String = "";
function onOpen2(e:Event):void { log2 += "open;"; }
function onProgress2(e:ProgressEvent):void { log2 += "progress;"; }
function onComplete2(e:Event):void { log2 += "complete;"; }
function onError2(e:Event):void { log2 += "ioError;"; }
l2.addEventListener(Event.OPEN, onOpen2);
l2.addEventListener(ProgressEvent.PROGRESS, onProgress2);
l2.addEventListener(Event.COMPLETE, onComplete2);
l2.addEventListener(IOErrorEvent.IO_ERROR, onError2);
l2.load(new URLRequest("examples/urlloader-contract.as"));
l2.close(); // same frame: the job is still queued
tickTimers();
check(log2 == "", "close() suppresses every terminal event");
check(l2.data == null, "a closed load leaves data null");

// --- close() with nothing in flight is AIR's "invalid stream error". The job
// above has been retired by tickTimers(), so this is the no-stream case. ---
var threw:Boolean = false;
try {
  l2.close();
} catch (err:Error) {
  threw = true;
}
check(threw, "close() throws an invalid stream error when nothing is streaming");

// --- The loader stays usable after a close(): a new load runs normally. ---
l2.load(new URLRequest("examples/urlloader-contract.as"));
check(l2.data == null, "load() resets data");
check(l2.bytesLoaded == 0 && l2.bytesTotal == 0, "load() resets the byte counters");
tickTimers();
check(log2 == "open;progress;complete;", "a load after close() completes normally");

// --- dataFormat = URLVariables turns the payload into a URLVariables object.
// AIR's one dataFormat where `data` is neither a String nor a ByteArray. ---
var fixture:File = new File("urlloader_contract_query.txt");
var fout:FileStream = new FileStream();
fout.open(fixture, FileMode.WRITE);
fout.writeUTFBytes("name=John%20Doe&age=42&empty=");
fout.close();

var l3:URLLoader = new URLLoader();
l3.dataFormat = URLLoaderDataFormat.VARIABLES;
var l3done:Boolean = false;
function onComplete3(e:Event):void { l3done = true; }
l3.addEventListener(Event.COMPLETE, onComplete3);
l3.load(new URLRequest("urlloader_contract_query.txt"));
tickTimers();
check(l3done, "a VARIABLES load completes");
check(l3.data is URLVariables, "dataFormat=VARIABLES yields a URLVariables, not a String");
var decoded:URLVariables = l3.data as URLVariables;
check(decoded.name == "John Doe", "the payload is percent-decoded");
check(decoded.age == "42", "decoded values are Strings");
check(decoded.empty == "", "an empty value decodes to an empty String");
fixture.deleteFile();

// --- A transport failure carries AIR's number (2032 "Stream Error") as well as
// its sentence. URLLoader and URLStream both use 2032 for every failure kind
// (missing local file, refused connection, DNS, and a 4xx when no
// httpResponseStatus listener is registered) — measured against adl, see
// docs/zh-cn/flash-net.md §6.7.5. The number is what AS3 code switches on, so a
// bare id=0 made the failure untestable. A local miss is used here because it is
// deterministic and needs no network.
var l4:URLLoader = new URLLoader();
var l4text:String = "";
var l4id:int = -1;
var l4done:Boolean = false;
function onError4(e:IOErrorEvent):void { l4text = e.text; l4id = e.errorID; l4done = true; }
l4.addEventListener(IOErrorEvent.IO_ERROR, onError4);
l4.load(new URLRequest("definitely/not/a/real/file.txt"));
tickTimers();
check(l4done, "a missing local file surfaces as an ioError");
check(l4id == 2032, "URLLoader's ioError carries AIR's #2032: " + l4id);
check(l4text == "Error #2032: Stream Error. URL: definitely/not/a/real/file.txt",
      "#2032 carries AIR's exact sentence and the offending URL: " + l4text);

System.output("urlloader-contract: all URLLoader contract assertions passed\n");
// --- A zero-length body emits no PROGRESS event at all. AIR sequences a 200
// with an empty body as open;httpStatus(200);complete (and an empty 404 as
// open;httpStatus(404);ioError) — measured with a local server, see
// temp/httpstatus-probe2 cases I/J and docs/zh-cn/flash-net.md §6.2. A missing
// terminal PROGRESS is easy to "fix" back into existence, and a local empty read
// reaches the rule with no network, so it is pinned here.
var l5:URLLoader = new URLLoader();
var l5log:String = "";
var l5done:Boolean = false;
function onOpen5(e:Event):void { l5log += "open;"; }
function onProgress5(e:ProgressEvent):void { l5log += "progress;"; }
function onComplete5(e:Event):void { l5log += "complete;"; l5done = true; }
l5.addEventListener(Event.OPEN, onOpen5);
l5.addEventListener(ProgressEvent.PROGRESS, onProgress5);
l5.addEventListener(Event.COMPLETE, onComplete5);
l5.load(new URLRequest("examples/empty.bin"));
tickTimers();
check(l5done, "a zero-length load still completes");
check(l5log == "open;complete;", "a zero-length body emits no PROGRESS (AIR): " + l5log);
