// stage243-move-to-trash.as — File.moveToTrash / moveToTrashAsync / spaceAvailable
// (v0.4.207, 阶段二百四十三) — file is examples/move-to-trash.as.
//
// The two members this example pins were measured against adl 51.4.1 on macOS 26
// (temp/trashprobe/) and again on Windows (temp/trashwin/) before they were written;
// the assertions below are those measurements, not an interpretation of the
// documentation. The Windows run is what settled the one platform question the AS3
// reference answers only in passing -- see the trash helpers below.
//   * moveToTrash() is declared VOID and evaluates to undefined -- it does NOT
//     return a Boolean, which the AIR reference suggests.
//   * a missing path throws #3003, a filesystem refusal throws #2038, and a File
//     with no nativePath throws #2037.
//   * a successful move leaves nativePath untouched and exists becomes false.
//   * moveToTrashAsync() reports the failure as an ioError event (errorID 3003)
//     and the success as COMPLETE; only the empty-File case throws.
//   * spaceAvailable is a real volume query; a path the OS cannot resolve, and a
//     path that is neither a regular file nor a directory (a device), report 0.
//
// The suite runs this example with HOME pointed at a throwaway directory (see
// EXAMPLE_ENV in test/examples.ts) so the trash it writes is not the user's; run
// it by hand and it trashes one small file out of $HOME and then deletes it. HOME is
// not what File.userDirectory reads on Windows, so there the items land in the real
// Recycle Bin -- this example removes exactly the entries it created before it
// returns, which is why it may only ever be run to completion.
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.filesystem.File;
import flash.filesystem.FileMode;
import flash.filesystem.FileStream;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function write(path:File, body:String):void {
  var fs:FileStream = new FileStream();
  fs.open(path, FileMode.WRITE);
  fs.writeUTFBytes(body);
  fs.close();
}

function errorIdOf(f:Function):int {
  try { f(); } catch (e:Error) { return e.errorID; }
  return 0;
}

// Where a trashed item lands differs by host, and on Windows it is not a directory
// holding the item under its own name at all: the Recycle Bin is a per-user store of
// $I<id> metadata + $R<id> payload pairs under the C: drive, reachable only through
// the shell. Each $I record ends with the item's ORIGINAL path as UTF-16LE -- which
// is exactly how a recycled item is told apart from an erased one, the distinction
// the AS3 reference leaves to a single sentence ("on operating systems that do not
// support the concept of a recoverable trash folder, the files are removed
// immediately"). Measured: Windows recycles, so both halves hold there too.
function isWindows():Boolean { return File.separator.charCodeAt(0) == 92; }

// Where a trashed item lands, per POSIX layout. Both are checked because the example
// is also run by hand on a Linux box.
function trashDirs():Array {
  return [
    File.userDirectory.resolvePath(".Trash"),                        // macOS
    File.userDirectory.resolvePath(".local/share/Trash/files")       // freedesktop
  ];
}

function recycleBinDirs():Array {
  var out:Array = [];
  // Windows only: on POSIX "C:/$Recycle.Bin" is a RELATIVE path, which AIR's File
  // constructor rejects with #2004 (and this build now does too).
  if (File.separator != "\\") return out;
  var root:File = new File("C:" + File.separator + "$Recycle.Bin");
  if (!root.exists) return out;
  try {
    for each (var sub:File in root.getDirectoryListing()) if (sub.isDirectory) out.push(sub);
  } catch (e:Error) {}
  return out;
}

// The original path out of a $I record: [8-byte header][8-byte size][8-byte
// FILETIME][4-byte name length][name as UTF-16LE, NUL terminated]. Decoded by hand
// rather than with readMultiByte, which on a build without iconv has no "unicode"
// charset to offer. NULs become separators so the recorded path stays delimited.
function recordedPath(key:File):String {
  var raw:ByteArray = new ByteArray();
  var fs:FileStream = new FileStream();
  try {
    fs.open(key, FileMode.READ);
    fs.readBytes(raw, 0, fs.bytesAvailable);
    fs.close();
  } catch (e:Error) { return ""; }
  var out:String = "";
  while (raw.bytesAvailable >= 2) {
    var lo:int = raw.readUnsignedByte();
    var hi:int = raw.readUnsignedByte();
    var code:int = lo | (hi << 8);
    out += (code == 0 ? "|" : String.fromCharCode(code));
  }
  return out;
}

// Each hit is a [key, payload] pair -- the $I metadata record and the $R payload that
// shares its id. A pair rather than two parallel arrays so a caller cannot mismatch
// them, and an Array rather than an object literal so this stays inside the subset.
function recycleHits(token:String):Array {
  var out:Array = [];
  for each (var d:File in recycleBinDirs()) {
    var kids:Array;
    try { kids = d.getDirectoryListing(); } catch (e:Error) { continue; }
    for each (var k:File in kids) {
      if (k.name.substr(0, 2) != "$I") continue;
      if (recordedPath(k).indexOf(token) < 0) continue;
      out.push([k, d.resolvePath("$R" + k.name.substr(2))]);
    }
  }
  return out;
}

// A File whose payload can be read back, whichever host put it there: on POSIX the
// trashed entry itself, on Windows the $R half of the pair.
function findInTrash(name:String):File {
  if (isWindows()) {
    var hits:Array = recycleHits(name);
    return (hits.length > 0) ? File(hits[0][1]) : null;
  }
  for each (var d:File in trashDirs()) {
    var f:File = d.resolvePath(name);
    if (f.exists) return f;
  }
  return null;
}

// How many trash entries now hold something named `name` -- 2 once that name has been
// trashed twice, because neither host overwrites: macOS appends a timestamp and
// Windows allocates a fresh $R id.
function trashedCount(name:String):int {
  if (isWindows()) return recycleHits(name).length;
  var n:int = 0;
  for each (var d:File in trashDirs()) {
    if (!d.exists) continue;
    for each (var f:File in d.getDirectoryListing()) if (f.name.indexOf(name) == 0) n++;
  }
  return n;
}

var base:File = File.userDirectory.resolvePath("as3aot-stage243-" + new Date().getTime());
base.createDirectory();
check(base.isDirectory, "probe directory created");

// --- the API shape -----------------------------------------------------------
var probe:File = new File();
check(typeof probe.moveToTrash == "function", "moveToTrash is a method");
check(typeof probe.moveToTrashAsync == "function", "moveToTrashAsync is a method");

// --- a plain file goes to the trash, and the receiver is not rewritten --------
var a:File = base.resolvePath("stage243-plain.txt");
write(a, "hello trash");
check(a.exists, "source exists before the move");
var before:String = a.nativePath;
a.moveToTrash();
check(a.exists == false, "exists is false after moveToTrash");
check(a.nativePath == before, "nativePath is UNCHANGED after moveToTrash");
var landed:File = findInTrash("stage243-plain.txt");
check(landed != null, "the file is in the trash and still there to be read back");
var fs:FileStream = new FileStream();
fs.open(landed, FileMode.READ);
var back:String = fs.readUTFBytes(fs.bytesAvailable);
fs.close();
check(back == "hello trash", "the trashed copy still carries the payload");

// --- a name that is already in the trash gets a second entry -----------------
// Measured: on macOS the copy is renamed "x.txt" -> "x.txt 18-34-09-271.txt" (the
// whole name, a space, the local time, then the extension again); on Windows the
// stored name is unchanged and only the $R/$I id is fresh. Either way the original
// stays restorable, so the count is what is asserted, not the spelling.
var b:File = base.resolvePath("stage243-plain.txt");
write(b, "second copy");
b.moveToTrash();
check(b.exists == false, "the second copy left its source path");
var dups:int = trashedCount("stage243-plain.txt");
check(dups >= 2, "the colliding name landed as a second entry (got " + dups + ")");

// --- a directory goes to the trash with its contents -------------------------
var dir:File = base.resolvePath("stage243-dir");
dir.createDirectory();
write(dir.resolvePath("inner.txt"), "inner");
dir.moveToTrash();
check(dir.exists == false, "the directory left its source path");
check(base.resolvePath("stage243-dir/inner.txt").exists == false, "its child went with it");

// --- the three failures -------------------------------------------------------
var missing:File = base.resolvePath("never-existed.txt");
check(errorIdOf(function():void { missing.moveToTrash(); }) == 3003, "a missing path throws #3003");
check(errorIdOf(function():void { new File().moveToTrash(); }) == 2037, "an empty File throws #2037");

// --- the async half: events, not exceptions, and LATER ------------------------
// Measured on adl 51.4.1 (temp/fileempty/): the move has not happened when the
// call returns and the event arrives on a following frame, so the assertions pump
// one frame with tickTimers() after each call.
var c:File = base.resolvePath("stage243-async.txt");
write(c, "async");
var events:Array = [];
c.addEventListener(Event.COMPLETE, function(ev:Event):void { events.push("complete"); });
c.moveToTrashAsync();
check(events.length == 0, "nothing is dispatched synchronously");
tickTimers();
check(events.indexOf("complete") >= 0, "moveToTrashAsync dispatches COMPLETE");
check(c.exists == false, "the async form moved the file");
check(findInTrash("stage243-async.txt") != null, "the async form landed in the trash");

var ioId:int = 0;
var n:File = base.resolvePath("never-existed-async.txt");
n.addEventListener(IOErrorEvent.IO_ERROR, function(ev:IOErrorEvent):void { ioId = ev.errorID; });
n.moveToTrashAsync();
tickTimers();
check(ioId == 3003, "moveToTrashAsync reports a missing path as ioError 3003 (got " + ioId + ")");
check(errorIdOf(function():void { new File().moveToTrashAsync(); }) == 2037, "the async form still throws #2037 on an empty File");

// --- spaceAvailable ----------------------------------------------------------
var home:File = File.userDirectory;
check(home.spaceAvailable > 0, "spaceAvailable reports the volume's free bytes");
var here:File = base.resolvePath("stage243-space.txt");
write(here, "x");
check(here.spaceAvailable > 0, "spaceAvailable answers for a regular file too");
check(base.resolvePath("no/such/path").spaceAvailable == 0, "spaceAvailable is 0 for a path the OS cannot resolve");
check(new File("/dev/null").exists ? new File("/dev/null").spaceAvailable == 0 : true,
      "spaceAvailable is 0 for a device (measured: AIR answers only for files and directories)");
here.deleteFile();

// --- cleanup: empty the trash entries this run created, then the probe dir ----
// `purge` empties one POSIX trash entry; the Windows half deletes the $R payload and
// the $I record as the pair they are. The Windows token is the whole base directory
// name because a $I record holds the item's full original path, whereas a POSIX
// trash entry is named after the item alone.
function purge(f:File):void {
  if (f.isDirectory) {
    for each (var child:File in f.getDirectoryListing()) purge(child);
    f.deleteDirectory();
  } else {
    f.deleteFile();
  }
}

function purgeTrash(token:String):void {
  if (isWindows()) {
    for each (var hit:Array in recycleHits(token)) {
      var key:File = File(hit[0]);
      var payload:File = File(hit[1]);
      // A recycled DIRECTORY keeps a directory as its $R payload, so deleteFile()
      // would leave it behind: orphaned, invisible in the Recycle Bin (the $I record
      // is gone) and yet still on disk. purge() handles either kind.
      try { if (payload.exists) purge(payload); } catch (e:Error) {}
      try { if (key.exists) key.deleteFile(); } catch (e:Error) {}
    }
    return;
  }
  for each (var t:File in trashDirs()) {
    if (!t.exists) continue;
    for each (var item:File in t.getDirectoryListing()) {
      if (item.name.indexOf(token) == 0) purge(item);
    }
  }
}

purgeTrash(isWindows() ? base.name : "stage243-");
// The cleanup is asserted, not merely performed: deleting the $I record hides an
// entry from the Recycle Bin while its $R payload may still be on disk, so "the bin
// looks empty" is exactly the state a half-done purge leaves behind.
if (isWindows()) {
  check(recycleHits(base.name).length == 0, "every recycled entry this run made is gone");
} else {
  check(trashedCount("stage243-") == 0, "every trashed entry this run made is gone");
}
base.deleteDirectory();
check(base.exists == false, "probe directory removed");

trace("stage243-move-to-trash: OK");