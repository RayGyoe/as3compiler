// stage64.as — flash.filesystem (v0.3.65): File / FileStream / FileMode.
//
// File is a filesystem path bundle (nativePath + "file://" url, exists/
// isDirectory/resolvePath/createDirectory/deleteFile/deleteDirectory backed by
// POSIX stat/mkdir/remove). FileStream is a FILE* wrapper (open/close/
// readUTFBytes/writeUTFBytes + read-only position/bytesAvailable). NativeWindow
// and SQLConnection/SQLStatement are deferred (native multi-window + SQLite).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- FileMode constants ---
check(FileMode.READ == "read" && FileMode.WRITE == "write", "FileMode READ/WRITE");
check(FileMode.APPEND == "append" && FileMode.UPDATE == "update", "FileMode APPEND/UPDATE");

// --- File: path bundle + url + existence ---
var f:File = new File("stage64_test.txt");
check(f is File && f is EventDispatcher, "File is EventDispatcher");
check(f.nativePath == "stage64_test.txt", "File nativePath stored");
check(f.url == "file://stage64_test.txt", "File url is file:// + path");
check(f.exists == false, "file does not exist yet");

// --- FileStream: write then read roundtrip ---
var out:FileStream = new FileStream();
check(out is FileStream && out is EventDispatcher, "FileStream is EventDispatcher");
out.open(f, FileMode.WRITE);
check(out.position == 0, "position 0 after open(write)");
out.writeUTFBytes("hello stage64");
out.close();
check(f.exists, "file exists after write");

var inp:FileStream = new FileStream();
inp.open(f, FileMode.READ);
check(inp.bytesAvailable == 13, "bytesAvailable 13");
var text:String = inp.readUTFBytes(13);
check(text == "hello stage64", "readUTFBytes roundtrip");
inp.close();

// --- File: resolvePath + directory create/delete ---
var child:File = f.resolvePath("subdir");
check(child.nativePath == "stage64_test.txt/subdir", "resolvePath joins with /");
var d:File = new File("stage64_dir");
d.createDirectory();
check(d.exists && d.isDirectory, "createDirectory makes a directory");
d.deleteDirectory();
check(d.exists == false, "deleteDirectory removes it");

// --- File static directory shortcuts (resolved from the environment) ---
check(File.applicationDirectory != null, "applicationDirectory non-null");
check(File.applicationDirectory.nativePath == ".", "applicationDirectory maps to CWD");
check(File.userDirectory != null, "userDirectory non-null");
check(File.documentsDirectory != null, "documentsDirectory non-null");
check(File.desktopDirectory != null, "desktopDirectory non-null");
check(File.documentsDirectory.nativePath.indexOf("Documents") >= 0, "documentsDirectory ends with Documents");
check(File.desktopDirectory.nativePath.indexOf("Desktop") >= 0, "desktopDirectory ends with Desktop");

// --- FileStream: asynchronous open (PROGRESS + COMPLETE deferred to next tick) ---
var asyncFs:FileStream = new FileStream();
var asyncProgress:Boolean = false;
var asyncComplete:Boolean = false;
var asyncBytes:Number = 0;
function onProgress(e:ProgressEvent):void { asyncProgress = true; asyncBytes = e.bytesLoaded; }
function onAsyncComplete(e:Event):void { asyncComplete = true; }
asyncFs.addEventListener(ProgressEvent.PROGRESS, onProgress);
asyncFs.addEventListener(Event.COMPLETE, onAsyncComplete);
asyncFs.openAsync(f, FileMode.READ);
check(!asyncComplete, "openAsync does not complete synchronously");
tickTimers();
check(asyncComplete, "openAsync dispatches COMPLETE on next tick");
check(asyncProgress, "openAsync dispatches PROGRESS");
check(asyncBytes == 13, "PROGRESS reports full byte count");
asyncFs.close();

// cleanup the roundtrip file
f.deleteFile();
check(f.exists == false, "deleteFile removes it");

trace("stage64: all flash.filesystem assertions passed");
