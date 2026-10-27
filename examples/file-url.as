// file-url.as — File.url is a URL, and the same string has to work as a path
// (阶段二百八十四).
//
// The bug this pins: TalkMED's gift popup downloads each icon into
// File.applicationStorageDirectory and then loads it by
// `downLoader.targetFile.url` (cn.edoctor.controls.Image). File.url used to be
// "file://" + nativePath, i.e. "file://C:\Users\...\Local Store\x.png" with
// backslashes and no encoding -- and that literal string was then fopen()'d, so
// every gift icon failed with IOError #2035 "URL Not Found" while the very same
// file loaded by nativePath decoded fine.
//
// The shape below is what AIR 51.4.1 actually produces (measured under adl; the
// probe lives in temp/urlprobe/):
//
//   File.applicationStorageDirectory.url  -> "app-storage:/"
//   File.applicationDirectory.url         -> "app:/"
//   <storage>/urlprobe/plain.png          -> "app-storage:/urlprobe/plain.png"
//   <storage>/a b/中文 name.png            -> "app-storage:/a%20b/%E4%B8%AD%E6%96%87%20name.png"
//   File.userDirectory (<home>)           -> "file:///C:/Users/<u>"  (win)
//   new File(<that url>).nativePath       -> the native path again
//
// So: two app roots get their own schemes, every other absolute path is
// "file:///" + percent-encoded path, and the File constructor decodes a URL back.
// One documented deviation stays: AIR throws #2004 for a relative path, this
// build keeps the string as-is (and so its url is "file://" + path).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- the two app roots get their own schemes ---
var store:File = File.applicationStorageDirectory;
check(store.url == "app-storage:/", "applicationStorageDirectory.url is app-storage:/ (was " + store.url + ")");
check(File.applicationDirectory.url == "app:/", "applicationDirectory.url is app:/ (was " + File.applicationDirectory.url + ")");

// --- a child of a root: scheme + "/" + the remainder, slashes normalized ---
var plain:File = store.resolvePath("file-url-test/a.png");
check(plain.url == "app-storage:/file-url-test/a.png", "storage child url keeps the scheme (was " + plain.url + ")");
check(plain.url.indexOf("\\") < 0, "url never contains a backslash");
check(plain.nativePath.indexOf("file-url-test") > 0, "nativePath is still a native path");

// --- percent-encoding: the URL is not the raw path ---
// Measured safe set: letters, digits, - _ . ! ~ * ' ( ) plus '/' and ':' (the
// drive letter). A space and every non-ASCII byte are encoded; the time stamp on
// the encoding is the UTF-8 triplet for the two characters below.
var spaced:File = store.resolvePath("file-url-test/a b/中文 name.png");
check(spaced.url == "app-storage:/file-url-test/a%20b/%E4%B8%AD%E6%96%87%20name.png",
      "space and CJK are percent-encoded (was " + spaced.url + ")");
check(spaced.url.indexOf(" ") < 0, "url has no literal space");

// --- the URL round-trips through the constructor ---
var again:File = new File(plain.url);
check(again.nativePath == plain.nativePath, "new File(url).nativePath == original (" + again.nativePath + ")");
check(again.url == plain.url, "url is idempotent through the constructor");
// AIR normalizes the same way for the encoded form, which is the case that used
// to echo the URL back as if it were a path.
check(new File(spaced.url).nativePath == spaced.nativePath, "encoded url resolves back to the native path");

// --- any other absolute path is "file:///" + encoded path ---
var home:File = File.userDirectory;
check(home.url.indexOf("file:///") == 0, "userDirectory.url starts with file:/// (was " + home.url + ")");
check(new File(home.url).nativePath == home.nativePath, "file:/// round-trips to the native path");

// --- the URL is a usable handle, not just a display string ---
// This is the part the gift icons needed: write through the native path, then
// find and read the file back through the URL alone.
var target:File = store.resolvePath("file-url-test.txt");
try { if (target.exists) target.deleteFile(); } catch (e:Error) { }
var out:FileStream = new FileStream();
out.open(target, FileMode.WRITE);
out.writeUTFBytes("hello url");
out.close();

var viaUrl:File = new File(target.url);
check(viaUrl.exists, "file written to nativePath is found through its url");
var inp:FileStream = new FileStream();
inp.open(viaUrl, FileMode.READ);
check(inp.bytesAvailable == 9, "bytesAvailable through the url-derived File");
check(inp.readUTFBytes(9) == "hello url", "readUTFBytes through the url-derived File");
inp.close();
target.deleteFile();
check(target.exists == false, "cleanup removed the test file");

// --- documented deviation: a relative path stays a relative path ---
// AIR throws #2004 in the constructor; this build keeps the string (stage64.as
// pins the same behaviour for nativePath), so its url is "file://" + path.
var rel:File = new File("temp/file-url-rel.txt");
// The separators inside a relative path follow the host (Windows stores it with a
// backslash); the path is still relative, which is the point of the deviation.
check(rel.nativePath == "temp" + File.separator + "file-url-rel.txt", "relative nativePath kept verbatim");
check(rel.url == "file://temp/file-url-rel.txt", "relative url is file:// + path (deviation, AIR throws #2004)");

trace("file-url: all File.url assertions passed");