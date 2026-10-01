// urlloader-network-unsupported.as — phase G of docs/zh-cn/flash-net.md:
// a REMOTE url must fail HONESTLY.
//
// This example pins the DEFAULT build, which links no HTTP backend. An http(s)://
// URL must then produce an IO_ERROR whose text names the real cause (the network
// is unsupported / not linked), so it is DISTINGUISHABLE from a missing local
// file. Before phase G both paths went through fopen() and reported the same
// generic "load failed", which is exactly the misleading deviation the design doc
// set out to remove: the caller could not tell a typo from an unimplemented
// transport. It must also never silently succeed and never hang.
//
// `data` on failure: AIR does NOT leave it null — a failed load publishes an
// EMPTY value (adl probe 8: data=String len=0, or an empty ByteArray when
// dataFormat=BINARY). This example pins that AIR shape, so it deliberately
// asserts data != null.
//
// A build that opts into the native backend (link-libs: ["curl"] +
// defines: ["ASC_HAVE_CURL"], see docs/zh-cn/compile.md) performs the transfer
// instead — that is the phase C probe. This example is about the NO-BACKEND
// contract, so it is written against the default build.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- an https:// URL: ioError with a text that blames the network ------------
var remoteLog:String = "";
var remoteText:String = "";
function onRemoteError(e:IOErrorEvent):void { remoteLog = "ioError"; remoteText = e.text; }
function onRemoteComplete(e:Event):void { remoteLog = "complete"; }

var l1:URLLoader = new URLLoader();
l1.addEventListener(IOErrorEvent.IO_ERROR, onRemoteError);
l1.addEventListener(Event.COMPLETE, onRemoteComplete);
l1.load(new URLRequest("https://example.com/data.json"));
tickTimers();

check(remoteLog == "ioError", "a remote URL must report ioError in a build without a network backend");
check(remoteText.length > 0, "the ioError must carry a text");
check(remoteText.indexOf("network") >= 0, "the error text must name the network as the cause");
// AIR leaves an EMPTY value, not null (adl probe 8) — the caller that switches on
// dataFormat always finds the right container type.
check(l1.data != null, "a failed load publishes an empty value, not null");
check(l1.data == "", "and for dataFormat=text that value is the empty String");
check(l1.bytesLoaded == 0 && l1.bytesTotal == 0, "a failed load leaves the byte counters at 0");

// --- http:// is treated the same way (both schemes are remote) --------------
var l2:URLLoader = new URLLoader();
l2.addEventListener(IOErrorEvent.IO_ERROR, onRemoteError);
l2.load(new URLRequest("http://example.com/data.json"));
tickTimers();
check(remoteLog == "ioError", "http:// is remote too and must report ioError");

// --- the missing FILE case still works, and is NOT the same failure ---------
// The whole point of phase G: the two failures are distinguishable. If this
// assertion ever stops holding, the error is misleading again.
var fileLog:String = "";
var fileText:String = "";
function onFileError(e:IOErrorEvent):void { fileLog = "ioError"; fileText = e.text; }

var l3:URLLoader = new URLLoader();
l3.addEventListener(IOErrorEvent.IO_ERROR, onFileError);
l3.load(new URLRequest("no/such/file/anywhere.txt"));
tickTimers();
check(fileLog == "ioError", "a missing file reports ioError");
check(fileText != remoteText, "a missing file and a remote URL must not share one error text");

// --- a local file still loads, so phase G did not break the working path ----
var l4:URLLoader = new URLLoader();
l4.load(new URLRequest("examples/urlloader-network-unsupported.as"));
tickTimers();
check(l4.data != null, "a local path still loads");
check(l4.data.indexOf("phase G") >= 0, "the local file content is the expected one");

trace("urlloader-network-unsupported: phase G honest-failure assertions passed");