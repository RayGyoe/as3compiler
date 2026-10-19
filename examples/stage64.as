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
// temp/ is the repo's scratch area (gitignored): the example must not litter its
// source dir. The suite runs every example with cwd = the repo root, so a bare
// relative path here lands in the checkout itself.
var f:File = new File("temp/stage64_test.txt");
check(f is File && f is EventDispatcher, "File is EventDispatcher");
check(f.nativePath == "temp/stage64_test.txt", "File nativePath stored");
check(f.url == "file://temp/stage64_test.txt", "File url is file:// + path");
// A leftover from an earlier run that threw mid-way (this example deletes its
// file at the end, so an aborted run leaves one behind) would fail the
// fresh-path assertion below for the wrong reason -- and does so only on the
// second run, which is the confusing part. Same guard, same reason as
// examples/sqlite-basic.as.
if (f.exists) f.deleteFile();
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
check(child.nativePath == "temp/stage64_test.txt/subdir", "resolvePath joins with /");
var d:File = new File("temp/stage64_dir");
d.createDirectory();
check(d.exists && d.isDirectory, "createDirectory makes a directory");
d.deleteDirectory();
check(d.exists == false, "deleteDirectory removes it");

// --- File static directory shortcuts (resolved from the environment) ---
check(File.applicationDirectory != null, "applicationDirectory non-null");
// applicationDirectory is the EXECUTABLE's directory, NOT the CWD: as_app_dir()
// derives it from the process's own path (GetModuleFileNameA / _NSGetExecutablePath
// / /proc/self/exe), i.e. the `-o` directory -- which is AIR's install-directory
// semantics and what lets a build be moved wholesale (docs/zh-cn/swc.md §11,
// docs/zh-cn/compile.md). There is no portable AS3 way to name that directory
// other than through this API, so pin the shape rather than a literal: it resolves
// to a real directory and resolvePath stays under it.
check(File.applicationDirectory.nativePath.length > 0, "applicationDirectory has a nativePath");
check(File.applicationDirectory.isDirectory, "applicationDirectory is a directory");
check(File.applicationDirectory.resolvePath("x").nativePath.indexOf(File.applicationDirectory.nativePath) == 0,
      "resolvePath stays under applicationDirectory");
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
