// upload-contract.as — the synchronous half of the File.upload contract, plus the
// one failure that is decided before any transport exists.
//
// All four behaviours below were measured against adl 51.4.1 with a capture server
// (temp/uploadprobe/, see the envelope comment on as_upload_begin in
// src/file-dialog.ts for the wire format itself):
//
//   * a FileReference with nothing selected throws #2037 from the CALL — it does
//     not return and dispatch an error later;
//   * an empty uploadDataFieldName throws #2085 from the call;
//   * a File whose path does not exist does NOT throw: the call returns, and
//     ioError #2038 naming the request URL arrives at a frame boundary, with NO
//     open and no progress event;
//   * uploadUnencoded has no field-name parameter, so the #2085 check cannot apply
//     to it (it is the raw-file-body form).
//
// This example is written against the DEFAULT build, which links no HTTP backend.
// It therefore pins only what AIR decides BEFORE the transfer: parameter
// validation, and the missing-file outcome, which is the same file-system fact with
// or without a transport. The multipart envelope itself needs a live server and is
// exercised by temp/uploadprobe on a transport-enabled build.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- a FileReference with no selected file -> #2037 -------------------------
var fr:FileReference = new FileReference();
var frErr:Error = null;
try {
  fr.upload(new URLRequest("http://127.0.0.1:9/upload"), "file");
} catch (e:Error) {
  frErr = e;
}
check(frErr != null, "upload() on a FileReference with no selection must throw");
check(frErr.errorID == 2037, "and AIR's id for that is 2037, got " + (frErr ? frErr.errorID : "none"));
check(frErr.message.indexOf("incorrect sequence") >= 0, "with AIR's sequence message, got: " + frErr.message);

// --- an empty uploadDataFieldName -> #2085 ----------------------------------
// The receiver must be a File that EXISTS, and there is no portable way to name
// this source file: `new File("a/b")` is #2004 by AIR's own rule (a relative path
// is an invalid parameter -- measured), and the absolute location of the example
// differs between the harness (temp/regress-out/) and a manual run (examples/).
// The application directory exists in BOTH layouts, and #2085 is decided before
// anything is opened, so it is enough here.
var f1:File = File.applicationDirectory;
var nameErr:Error = null;
try {
  f1.upload(new URLRequest("http://127.0.0.1:9/upload"), "");
} catch (e2:Error) {
  nameErr = e2;
}
check(nameErr != null, "an empty uploadDataFieldName must throw");
check(nameErr.errorID == 2085, "AIR's id for that is 2085, got " + (nameErr ? nameErr.errorID : "none"));
check(nameErr.message.indexOf("uploadDataFieldName") >= 0, "and the message names the parameter: " + nameErr.message);

// --- uploadUnencoded has no field name, so #2085 cannot fire ----------------
var f2:File = File.applicationDirectory;
var unencErr:Error = null;
try {
  f2.uploadUnencoded(new URLRequest("http://127.0.0.1:9/upload"));
  // The call is accepted; in this build the transport reports itself missing
  // (stderr) instead of dispatching an event AIR would never produce.
} catch (e3:Error) {
  unencErr = e3;
}
check(unencErr == null, "uploadUnencoded takes no field name and must not throw #2085, got " + (unencErr ? unencErr.errorID : "none"));

// --- a missing file: no throw, then ioError #2038 naming the URL ------------
var missing:File = File.applicationDirectory.resolvePath("no/such/upload-source.pptx");
var log:String = "";
var text:String = "";
missing.addEventListener(Event.OPEN, function(e:Event):void { log += "open;"; });
missing.addEventListener(ProgressEvent.PROGRESS, function(e:ProgressEvent):void { log += "progress;"; });
missing.addEventListener(Event.COMPLETE, function(e:Event):void { log += "complete;"; });
missing.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
  log += "ioError";
  text = e.text;
});
var missingThrew:Boolean = false;
try {
  missing.upload(new URLRequest("http://127.0.0.1:9/upload"), "file");
} catch (e4:Error) {
  missingThrew = true;
}
check(!missingThrew, "a missing source file must not throw from upload()");
tickTimers();
check(log == "ioError", "a missing source file reports exactly one ioError, got: " + log);
check(text.indexOf("2038") >= 0, "the ioError carries AIR's #2038, got: " + text);
check(text.indexOf("http://127.0.0.1:9/upload") >= 0, "and names the request URL, got: " + text);

trace("upload-contract: File.upload validation and missing-file assertions passed");