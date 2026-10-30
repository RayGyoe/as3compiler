// file-ops.as — File 的删除/移动/路径契约对齐（阶段二百九十八·A 批）
// — file is examples/file-ops.as.
//
// Batch A of the File audit: the members we already had, but whose SEMANTICS
// disagreed with adl 51.4.1. Every expectation below was measured on adl 51.4.1
// (macOS 26) first — probes in temp/fileaudit/adl/ (Fp.as, Av.as, Av2.as, Av3.as,
// outputs out.txt / av.txt / av2.txt / av3.txt) — and this example then pins the
// same lines through this compiler. What changed:
//
//   * deleteDirectory(deleteDirectory = false) exists at all: AIR declares one
//     parameter (mxmlc rejects the 0-argument call we used to accept) and it
//     means RECURSIVE — with it set, a FILE path is deleted too.
//   * deleteFile / deleteDirectory THROW the measured ids instead of silently
//     doing nothing: #2037 (no nativePath) / #3003 (missing) / #3006 (a real
//     directory, from deleteFile) / #3007 (not a directory) / #3010 (not empty,
//     from deleteDirectory(false)) / #3001 (access denied).
//   * moveTo is a TWO-parameter member (AIR has no `force`), creates the
//     destination's parent directories, throws #3012 when the target exists and
//     overwrite is false, and — measured twice — leaves the receiver's
//     nativePath pointing at the OLD location.
//   * size throws #3003 on a missing path (the old code returned 0 and a comment
//     claimed AIR did the same: it does not) and answers 0 for a DIRECTORY.
//   * paths are normalised LEXICALLY everywhere a path is stored or resolved
//     ("//", ".", "..", a trailing separator), and an ABSOLUTE argument to
//     resolvePath replaces the base instead of being appended to it.
//
// The deletes go through lstat(), not stat(): AIR deletes the LINK, never its
// target, so deleteFile on a symlink to a directory succeeds and leaves the
// directory intact. The `fx/` fixture that proves it is built by node:fs before
// the run (test/examples.ts, EXAMPLE_ENV), because AS3 cannot create a link; on a
// host whose account is not allowed to create one, those units are skipped.
import flash.filesystem.File;
import flash.filesystem.FileStream;
import flash.filesystem.FileMode;
import flash.events.Event;
import flash.events.IOErrorEvent;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function eq(actual:Object, expected:Object, msg:String):void {
  check(String(actual) == String(expected), msg + " (got '" + actual + "', want '" + expected + "')");
}

// Run `f` expecting a particular errorID; returns the caught Error, or null.
function threw(f:Function, id:int, msg:String):Error {
  try { f(); } catch (e:Error) { eq(e.errorID, id, msg); return e; }
  throw new Error("FAIL: " + msg + " (nothing thrown)");
}
function noThrow(f:Function, msg:String):void {
  try { f(); } catch (e:Error) { throw new Error("FAIL: " + msg + " (threw #" + e.errorID + ": " + e.message + ")"); }
}

var fx:File = File.userDirectory.resolvePath("fx");
var work:File = File.userDirectory.resolvePath("work");
if (work.exists) work.deleteDirectory(true);
work.createDirectory();

// ------------------------------------------------------- constructor contract
// Measured on adl 51.4.1 (temp/fileempty/): the constructor requires an ABSOLUTE
// native path or one of the three URL schemes AIR accepts, an explicit null is
// #2037 (it does NOT mean "empty"), and only the no-argument form builds the empty
// File. This used to accept a relative path and keep it verbatim -- a registered
// deviation that this stage closes.
threw(function():void { new File("temp/a.txt"); }, 2004, "the ctor rejects a relative path");
threw(function():void { new File("./a.txt"); }, 2004, "the ctor rejects ./a.txt");
threw(function():void { new File("../a.txt"); }, 2004, "the ctor rejects ../a.txt");
threw(function():void { new File(""); }, 2004, "the ctor rejects an empty string");
threw(function():void { new File("a"); }, 2004, "the ctor rejects a bare word");
threw(function():void { new File("http://example.com/a"); }, 2004, "the ctor rejects a non-file url");
threw(function():void { new File(null); }, 2037, "the ctor refuses an explicit null with #2037");
noThrow(function():void { new File(); }, "the no-argument form builds the empty File");
eq(new File("/tmp//a/../b").nativePath, "/tmp/b", "an absolute path is still normalised");

// ------------------------------------------------- empty File answers #2037 only
// Every member that needs a path throws #2037 on a File built with `new File()`;
// only preventBackup, data, toString() and clone() answer (all measured).
var blank:File = new File();
threw(function():void { var v:* = blank.nativePath; }, 2037, "nativePath on an empty File");
threw(function():void { var v:* = blank.url; }, 2037, "url on an empty File");
threw(function():void { var v:* = blank.name; }, 2037, "name on an empty File");
threw(function():void { var v:* = blank.extension; }, 2037, "extension on an empty File");
threw(function():void { var v:* = blank.type; }, 2037, "type on an empty File");
threw(function():void { var v:* = blank.parent; }, 2037, "parent on an empty File");
threw(function():void { var v:* = blank.exists; }, 2037, "exists on an empty File");
threw(function():void { var v:* = blank.isDirectory; }, 2037, "isDirectory on an empty File");
threw(function():void { var v:* = blank.isHidden; }, 2037, "isHidden on an empty File");
threw(function():void { var v:* = blank.isSymbolicLink; }, 2037, "isSymbolicLink on an empty File");
threw(function():void { var v:* = blank.isPackage; }, 2037, "isPackage on an empty File");
threw(function():void { var v:* = blank.size; }, 2037, "size on an empty File");
threw(function():void { var v:* = blank.spaceAvailable; }, 2037, "spaceAvailable on an empty File");
threw(function():void { var v:* = blank.creationDate; }, 2037, "creationDate on an empty File");
threw(function():void { var v:* = blank.modificationDate; }, 2037, "modificationDate on an empty File");
threw(function():void { var v:* = blank.downloaded; }, 2037, "downloaded on an empty File");
threw(function():void { var v:* = blank.creator; }, 2037, "creator on an empty File");
threw(function():void { var v:* = blank.icon; }, 2037, "icon on an empty File");
eq(blank.preventBackup, false, "preventBackup answers false on an empty File");
eq(blank.data, null, "data answers null on an empty File");
eq(String(blank), "[object File]", "toString still works on an empty File");
noThrow(function():void { blank.clone(); }, "clone() on an empty File does not throw");

// ---------------------------------------------------------------- path strings
// Lexical normalisation, measured in av.txt E1-E5 / av2.txt J1-J5.
eq(new File("/tmp//a/../b").nativePath, "/tmp/b", "ctor folds // and ..");
eq(new File("/tmp/./").nativePath, "/tmp", "ctor drops '.' and a trailing /");
eq(new File("/tmp/..").nativePath, "/", "ctor clamps .. at the root");
eq(new File("//tmp").nativePath, "/tmp", "ctor folds a doubled root");
eq(new File("/tmp/a b //x.txt").nativePath, "/tmp/a b /x.txt", "ctor keeps spaces, folds //");
// POSIX: a backslash is a legal filename byte, NOT a separator (av2.txt J1).
eq(new File("/tmp/a\\b").nativePath, "/tmp/a\\b", "ctor keeps a backslash on POSIX");

// The setter normalises too, and rejects what AIR rejects (av.txt F1-F6).
var np:File = new File();
noThrow(function():void { np.nativePath = "/tmp/a/"; }, "nativePath setter accepts an absolute path");
eq(np.nativePath, "/tmp/a", "nativePath setter strips the trailing separator");
threw(function():void { np.nativePath = "rel/a/../b.txt"; }, 2004, "nativePath setter rejects a relative path");
threw(function():void { np.nativePath = ""; }, 2004, "nativePath setter rejects an empty path");
threw(function():void { np.nativePath = "file:///tmp/a%20b.txt"; }, 2004, "nativePath setter rejects a URL");
var nullErr:Error = threw(function():void { np.nativePath = null; }, 2007, "nativePath setter rejects null");
// AIR's own message has an EMPTY parameter name, hence the double space.
eq(nullErr.message, "Error #2007: Parameter  must be non-null.", "nativePath null message is AIR's verbatim");

// resolvePath: measured in av.txt G1-G11 / Fp.as 1a-1e.
var base:File = new File("/tmp/asaot-base");
eq(base.resolvePath("").nativePath, "/tmp/asaot-base", "resolvePath('') is the base");
eq(base.resolvePath(".").nativePath, "/tmp/asaot-base", "resolvePath('.') is the base");
eq(base.resolvePath("..").nativePath, "/tmp", "resolvePath('..') walks up");
eq(base.resolvePath("../x").nativePath, "/tmp/x", "resolvePath('../x')");
eq(base.resolvePath("a/../b").nativePath, "/tmp/asaot-base/b", "resolvePath normalises ..");
eq(base.resolvePath("a//b").nativePath, "/tmp/asaot-base/a/b", "resolvePath folds //");
eq(base.resolvePath("/abs/./q").nativePath, "/abs/q", "an absolute argument REPLACES the base");
eq(base.resolvePath("~/x").nativePath, "/tmp/asaot-base/~/x", "no '~' expansion");
eq(base.resolvePath("../../../../x").nativePath, "/x", ".. clamps at the root");
threw(function():void { new File().resolvePath("x"); }, 2037, "resolvePath on an empty File");
threw(function():void { base.resolvePath(null); }, 2007, "resolvePath(null)");

// ---------------------------------------------------------------- deleteFile
var f1:File = work.resolvePath("f1.txt");
var st:FileStream = new FileStream();
st.open(f1, FileMode.WRITE); st.writeUTFBytes("hello"); st.close();
eq(f1.size, 5, "size of a 5-byte file");
threw(function():void { work.resolvePath("nope.txt").deleteFile(); }, 3003, "deleteFile on a missing path");
threw(function():void { new File().deleteFile(); }, 2037, "deleteFile on an empty File");
var d1:File = work.resolvePath("d1"); d1.createDirectory();
threw(function():void { d1.deleteFile(); }, 3006, "deleteFile on a real directory is #3006");
check(d1.exists, "the directory survives the refused deleteFile");
noThrow(function():void { f1.deleteFile(); }, "deleteFile on a file");
check(!f1.exists, "deleteFile removed the file");

// A symlink to a directory: the LINK goes, the target stays (av3.txt K1).
if (fx != null && fx.exists) {
  var linkDir:File = fx.resolvePath("linkdir");
  check(linkDir.exists, "fixture link to a directory is visible through stat");
  noThrow(function():void { linkDir.deleteFile(); }, "deleteFile on a symlink-to-directory succeeds");
  check(!linkDir.exists && !linkDir.isSymbolicLink, "the link itself is gone");
  check(fx.resolvePath("dir").exists, "the link's TARGET survives");
  // A dangling link has no stat() and no size, but deleteFile removes it.
  var dangle:File = fx.resolvePath("dangle");
  threw(function():void { var s:Number = dangle.size; }, 3003, "size of a dangling link");
  noThrow(function():void { dangle.deleteFile(); }, "deleteFile on a dangling link");
  check(!dangle.isSymbolicLink, "the dangling link is gone");
}

// ----------------------------------------------------------- deleteDirectory
var d2:File = work.resolvePath("d2");
d2.resolvePath("sub/deep").createDirectory();
var inner:FileStream = new FileStream();
inner.open(d2.resolvePath("sub/deep/x.txt"), FileMode.WRITE);
inner.writeUTFBytes("x"); inner.close();
threw(function():void { d2.deleteDirectory(); }, 3010, "deleteDirectory(false) on a non-empty directory");
check(d2.exists, "the non-empty directory survives");
noThrow(function():void { d2.deleteDirectory(true); }, "deleteDirectory(true) recurses");
check(!d2.exists, "the tree is gone");
// A FILE path with the flag set is deleted too (av.txt B3) ...
var f2:File = work.resolvePath("f2.txt");
var st2:FileStream = new FileStream();
st2.open(f2, FileMode.WRITE); st2.writeUTFBytes("y"); st2.close();
noThrow(function():void { f2.deleteDirectory(true); }, "deleteDirectory(file, true) deletes the file");
check(!f2.exists, "the file is gone");
// ... while without the flag it is the directory gate that speaks.
var f3:File = work.resolvePath("f3.txt");
var st3:FileStream = new FileStream();
st3.open(f3, FileMode.WRITE); st3.writeUTFBytes("z"); st3.close();
threw(function():void { f3.deleteDirectory(false); }, 3007, "deleteDirectory(file, false) is #3007");
check(f3.exists, "the file survives the refused deleteDirectory");
threw(function():void { work.resolvePath("nope2").deleteDirectory(true); }, 3003, "deleteDirectory on a missing path");
threw(function():void { new File().deleteDirectory(); }, 2037, "deleteDirectory on an empty File");
f3.deleteFile();

// ------------------------------------------------------------------ moveTo
var src:File = work.resolvePath("m1.txt");
var st4:FileStream = new FileStream();
st4.open(src, FileMode.WRITE); st4.writeUTFBytes("m"); st4.close();
var dest:File = work.resolvePath("z/y/dst.txt");
noThrow(function():void { src.moveTo(dest, false); }, "moveTo creates the destination's parent directories");
check(dest.exists && !src.exists, "the file moved");
// AIR leaves the receiver on the OLD path (measured twice: av.txt C3b/C6b).
eq(src.nativePath, work.resolvePath("m1.txt").nativePath, "moveTo does NOT rewrite nativePath");
// A missing source is #3003; a null destination is a TypeError with AIR's own
// parameter name ("destination", not "newFile").
threw(function():void { work.resolvePath("gone.txt").moveTo(dest, true); }, 3003, "moveTo with a missing source");
var nullDest:Error = threw(function():void { dest.moveTo(null); }, 2007, "moveTo(null)");
check(nullDest is TypeError, "moveTo(null) is a TypeError, not an ArgumentError");
eq(nullDest.message, "Error #2007: Parameter destination must be non-null.", "moveTo(null) message is AIR's verbatim");
// An existing target without overwrite is #3012, file or directory alike.
var other:File = work.resolvePath("other.txt");
var st5:FileStream = new FileStream();
st5.open(other, FileMode.WRITE); st5.writeUTFBytes("o"); st5.close();
threw(function():void { dest.moveTo(other, false); }, 3012, "moveTo onto an existing file without overwrite");
check(dest.exists && other.exists, "both survive the refused move");
var d3:File = work.resolvePath("d3"); d3.createDirectory();
threw(function():void { dest.moveTo(d3, false); }, 3012, "moveTo onto an existing directory without overwrite");
// With overwrite the target is replaced first -- even when it is a directory.
noThrow(function():void { dest.moveTo(d3, true); }, "moveTo onto a directory with overwrite");
check(!dest.exists && !d3.isDirectory && d3.exists, "the directory was replaced by the file");

// ------------------------------------------------------------- size / #3003
threw(function():void { work.resolvePath("missing-size.bin").size; }, 3003, "size of a missing path throws");
threw(function():void { new File().size; }, 2037, "size of an empty File throws");
var dd:File = work.resolvePath("sizedir"); dd.createDirectory();
eq(dd.size, 0, "size of a directory is 0, not its st_size");
eq(other.size, 1, "size of a 1-byte file");

// ---------------------------------------------------------- async delivery
// The async members report the SAME ids as events instead of throwing
// (av.txt H0, av3.txt I0), and they deliver them LATER: measured on adl 51.4.1
// (temp/fileempty/), the file still exists right after deleteFileAsync() returns,
// the event arrives on a following frame, a second call while one is in flight
// throws #2037, and cancel() drops the event without undoing the work. So every
// assertion below pumps one frame with tickTimers() before it looks at `seen`.
var seen:String = "";
var got:IOErrorEvent = null;
f3 = work.resolvePath("a1.txt");
st = new FileStream();
st.open(f3, FileMode.WRITE); st.writeUTFBytes("a"); st.close();
f3.addEventListener(Event.COMPLETE, function(e:Event):void { seen += "complete "; });
f3.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { seen += "error" + e.errorID + " "; });
f3.deleteFileAsync();
eq(seen, "", "nothing is delivered synchronously");
tickTimers();
eq(seen, "complete ", "deleteFileAsync on a file completes");
check(!f3.exists, "the async delete really deleted");
seen = "";
var miss:File = work.resolvePath("a2.txt");
miss.addEventListener(Event.COMPLETE, function(e:Event):void { seen += "complete "; });
miss.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { seen += "error" + e.errorID + " "; got = e; });
miss.deleteFileAsync();
tickTimers();
eq(seen, "error3003 ", "deleteFileAsync on a missing path is ioError #3003");
check(got != null && got.text == "Error #3003: File or directory does not exist.", "the ioError carries AIR's sentence");
seen = "";
var ad:File = work.resolvePath("a3");
ad.createDirectory();
var st6:FileStream = new FileStream();
st6.open(ad.resolvePath("x.txt"), FileMode.WRITE); st6.writeUTFBytes("x"); st6.close();
ad.addEventListener(Event.COMPLETE, function(e:Event):void { seen += "complete "; });
ad.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void { seen += "error" + e.errorID + " "; });
ad.deleteDirectoryAsync(false);
tickTimers();
eq(seen, "error3010 ", "deleteDirectoryAsync(false) on a non-empty directory is ioError #3010");
check(ad.exists, "the non-empty directory survives");
seen = "";
ad.deleteDirectoryAsync(true);
tickTimers();
eq(seen, "complete ", "deleteDirectoryAsync(true) recurses and completes");
check(!ad.exists, "the tree is gone");
threw(function():void { new File().deleteDirectoryAsync(true); }, 2037, "deleteDirectoryAsync on an empty File still throws");

// A second call before the first reports is #2037 (measured on adl 51.4.1).
seen = "";
var twice:File = work.resolvePath("a4.txt");
st = new FileStream();
st.open(twice, FileMode.WRITE); st.writeUTFBytes("x"); st.close();
twice.addEventListener(Event.COMPLETE, function(e:Event):void { seen += "complete "; });
twice.deleteFileAsync();
threw(function():void { twice.deleteFileAsync(); }, 2037, "a second deleteFileAsync in flight is #2037");
tickTimers();
eq(seen, "complete ", "the FIRST call still reports");

// cancel() drops the pending event (the work itself is already done, as in AIR).
seen = "";
var cancelled:File = work.resolvePath("a5.txt");
st = new FileStream();
st.open(cancelled, FileMode.WRITE); st.writeUTFBytes("x"); st.close();
cancelled.addEventListener(Event.COMPLETE, function(e:Event):void { seen += "complete "; });
cancelled.deleteFileAsync();
cancelled.cancel();
tickTimers();
eq(seen, "", "cancel() suppresses the pending event");

// ------------------------------------------------------------------- cleanup
work.deleteDirectory(true);
trace("file-ops: OK");