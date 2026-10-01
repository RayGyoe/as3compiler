// loader-url.as — Loader.load() routes an http(s) URL to the HTTP transport, not
// to the local file reader.
//
// Loader.load(URLRequest) has two sources behind one API: a local path (read +
// decode on the worker) and an http(s) URL (fetch the bytes, then decode the
// payload that came back). The route is chosen at submit time from the URL
// prefix, and a wrong route is indistinguishable from a correct one until it
// fails — so what the assertions below pin is the *diagnosis*, not the pixels:
//
//   1. A remote URL is never diagnosed as a missing file. Before the routing
//      existed the URL string was fopen()'d literally, so a build with no
//      transport linked reported a read failure ("Loader load failed") — an
//      honest message for the wrong cause. That negative invariant holds in
//      every build; the positive one (naming the missing transport) is specific
//      to this pure-C unit, where no HTTP backend is linked. The fetch path
//      itself is exercised by examples/url-test (two remote PNGs on the stage)
//      and by the Skia-backed acceptance demo.
//   2. Local paths keep their old diagnoses, now carrying AIR's NUMBER as well
//      as its sentence: a file that exists but cannot be decoded is #2124
//      "Loaded file is an unknown type" (a pure-C build links no decoder), a
//      missing file is #2035 "URL Not Found". The number is the part AS3 code
//      branches on (e.errorID), and it is measured against adl — the whole
//      matrix is in docs/zh-cn/flash-net.md §6.7.5.
//   3. A failed load publishes nothing: content stays null and the Loader gains
//      no child, so nothing silently renders as an empty Bitmap.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. A remote URL: transport failure, never a file-read failure ---
var remote:Loader = new Loader();
var remoteState:String = "";
var remoteText:String = "";
var remoteId:int = -1;
var remoteEvents:int = 0;
remote.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
  remoteState = "complete";
  remoteEvents++;
});
remote.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
  remoteState = "ioError";
  remoteText = e.text;
  remoteId = e.errorID;
  remoteEvents++;
});
remote.load(new URLRequest("https://meeting.talkmed.com/img/meeting_3.0bca6577.png"));
check(remoteState == "", "a remote load dispatches no event synchronously");
check(remote.content == null, "content stays null between load() and the terminal event");
check(remote.contentLoaderInfo.url == "https://meeting.talkmed.com/img/meeting_3.0bca6577.png",
      "contentLoaderInfo.url is the requested URL");
tickTimers();
check(remoteState == "ioError" && remoteEvents == 1, "a remote load settles as one IO_ERROR");
check(remoteText.indexOf("Loader load failed") < 0,
      "a remote URL is not diagnosed as a missing file: " + remoteText);
check(remoteText.indexOf("no HTTP backend") >= 0,
      "the pure-C build names the missing transport: " + remoteText);
// The missing-transport state is a property of THIS build, not something AIR can
// be in (AIR always has a transport), so it has no AIR number: errorID stays 0
// and the text stays the build-level sentence. Inventing a number here would be
// worse than leaving it unset — callers switch on these.
check(remoteId == 0, "a build-level transport gap carries no AIR error number: " + remoteId);
check(remote.content == null && remote.numChildren == 0, "a failed load publishes no content");

// The scheme decides, not the string: http:// takes the same route as https://.
var plain:Loader = new Loader();
var plainText:String = "";
plain.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
  plainText = e.text;
});
plain.load(new URLRequest("http://127.0.0.1:1/never-served.png"));
tickTimers();
check(plainText.indexOf("Loader load failed") < 0, "http:// is routed like https://: " + plainText);

// --- 2. Local paths keep their diagnoses, with AIR's number and sentence ---
// An existing file that is not an image: the read succeeds, the decode does not.
// AIR reports #2124 for exactly this (measured on adl with a text file).
var decoded:Loader = new Loader();
var decodedText:String = "";
var decodedId:int = -1;
decoded.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
  decodedText = e.text;
  decodedId = e.errorID;
});
decoded.load(new URLRequest("examples/async-io.as"));
tickTimers();
check(decodedId == 2124, "an undecodable local payload reports AIR's #2124: " + decodedId);
check(decodedText == "Error #2124: Loaded file is an unknown type. URL: examples/async-io.as",
      "#2124 carries AIR's exact sentence and the offending URL: " + decodedText);

// A path that is not there at all is a read failure, not a decode failure — and
// AIR numbers it 2035 "URL Not Found" (measured on adl).
var missing:Loader = new Loader();
var missingText:String = "";
var missingId:int = -1;
missing.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
  missingText = e.text;
  missingId = e.errorID;
});
missing.load(new URLRequest("definitely/not/a/real/image.png"));
tickTimers();
check(missingId == 2035, "a missing local file reports AIR's #2035: " + missingId);
check(missingText == "Error #2035: URL Not Found. URL: definitely/not/a/real/image.png",
      "#2035 carries AIR's exact sentence and the offending URL: " + missingText);
check(missing.content == null, "a missing local file publishes no content");

trace("loader-url: remote URL routing and local-path diagnoses OK");