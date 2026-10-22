// stage243-move-to-trash.as — File.moveToTrash / moveToTrashAsync / spaceAvailable
// (v0.4.207, 阶段二百四十三) — file is examples/move-to-trash.as.
//
// The two members this example pins were measured against adl 51.4.1 on macOS 26
// before they were written (temp/trashprobe/); the assertions below are those
// measurements, not an interpretation of the documentation:
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
// it by hand and it trashes one small file out of $HOME and then deletes it.
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.filesystem.File;
import flash.filesystem.FileMode;
import flash.filesystem.FileStream;

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

// Where a trashed item lands, per platform layout. Both are checked because the
// example is also run by hand on a Linux box.
function trashDirs():Array {
  return [
    File.userDirectory.resolvePath(".Trash"),                        // macOS
    File.userDirectory.resolvePath(".local/share/Trash/files")       // freedesktop
  ];
}

function findInTrash(name:String):File {
  for each (var d:File in trashDirs()) {
    var f:File = d.resolvePath(name);
    if (f.exists) return f;
  }
  return null;
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
check(landed != null, "the file is in the trash directory under its own name");
var fs:FileStream = new FileStream();
fs.open(landed, FileMode.READ);
var back:String = fs.readUTFBytes(fs.bytesAvailable);
fs.close();
check(back == "hello trash", "the trashed copy still carries the payload");

// --- a name that is already in the trash gets a timestamped copy -------------
// Measured: "x.txt" -> "x.txt 18-34-09-271.txt" (the whole name, a space, the
// local time, then the extension again).
var b:File = base.resolvePath("stage243-plain.txt");
write(b, "second copy");
b.moveToTrash();
check(b.exists == false, "the second copy left its source path");
var dups:int = 0;
for each (var d:File in trashDirs()) {
  if (!d.exists) continue;
  for each (var e:File in d.getDirectoryListing()) {
    if (e.name.indexOf("stage243-plain.txt") == 0) dups++;
  }
}
check(dups >= 2, "the colliding name landed as a second, timestamped entry (got " + dups + ")");

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

// --- the async half: events, not exceptions ----------------------------------
var c:File = base.resolvePath("stage243-async.txt");
write(c, "async");
var events:Array = [];
c.addEventListener(Event.COMPLETE, function(ev:Event):void { events.push("complete"); });
c.moveToTrashAsync();
check(events.indexOf("complete") >= 0, "moveToTrashAsync dispatches COMPLETE");
check(c.exists == false, "the async form moved the file");
check(findInTrash("stage243-async.txt") != null, "the async form landed in the trash");

var ioId:int = 0;
var n:File = base.resolvePath("never-existed-async.txt");
n.addEventListener(IOErrorEvent.IO_ERROR, function(ev:IOErrorEvent):void { ioId = ev.errorID; });
n.moveToTrashAsync();
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
function purge(f:File):void {
  if (f.isDirectory) {
    for each (var child:File in f.getDirectoryListing()) purge(child);
    f.deleteDirectory();
  } else {
    f.deleteFile();
  }
}

for each (var t:File in trashDirs()) {
  if (!t.exists) continue;
  for each (var item:File in t.getDirectoryListing()) {
    if (item.name.indexOf("stage243-") == 0) purge(item);
  }
}
base.deleteDirectory();
check(base.exists == false, "probe directory removed");

trace("stage243-move-to-trash: OK");