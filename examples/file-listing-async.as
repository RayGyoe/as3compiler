// stage264-file-listing-async.as — File.getDirectoryListingAsync really is async (阶段二百六十四)
// — file is examples/file-listing-async.as.
//
// This member used to be a synchronous fake: it called the sync
// getDirectoryListing() and dispatched FileListEvent.DIRECTORY_LISTING from the
// same call. That is wrong in four measurable ways, and this example pins all
// four. The oracle is adl 51.4.1 (temp/dirasync/, one probe through mxmlc + adl
// and one through this compiler, compared line by line):
//
//   1. DELIVERY IS DEFERRED. adl's call returns and the event arrives afterwards,
//      so a listener registered immediately AFTER the call still fires. With an
//      inline dispatch it never could -- and worse, the AS3 thread paid for the
//      whole walk: adl takes 0 ms to return from a 20,000-entry directory (the
//      event lands ~10.6 s later), where the old body enumerated 20,000 entries
//      before returning.
//   2. A MISSING PATH IS AN ioError #3003. It does not complete, and it does not
//      throw. Measured text is the short form, and both flags are false.
//   3. A PATH THAT IS NOT A DIRECTORY COMPLETES, with an EMPTY files array and no
//      error at all -- while the SYNC member throws #3007 ("Not a directory.")
//      for that same input. The two members genuinely differ; neither may be
//      derived from the other.
//   4. cancel() MEANS SOMETHING. It drops the pending listing (no event ever), and
//      a SECOND call while one is in flight throws #2037 while the first one still
//      completes. An empty File (new File()) throws the same #2037 up front.
//
// The one thing that did NOT change is the ORDER of files: adl's async order
// equals its sync order for the same path, and both are the raw directory order
// (neither sorts), so the check below compares the two listings instead of
// asserting an alphabetical order that no build ever produced.
import flash.events.Event;
import flash.events.FileListEvent;
import flash.events.IOErrorEvent;
import flash.filesystem.File;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var fx:File = File.userDirectory.resolvePath("fx");

// $HOME is what File.userDirectory reads here; on Windows it reads USERPROFILE, and if the
// fixture is not reachable there, say so loudly rather than passing on a run that asserted
// nothing. On POSIX the harness guarantees the fixture exists, so a missing one is a hard
// failure -- the whole point of this example is the assertions, so it must not run empty.
var skip:Boolean = false;
if (!fx.exists) {
  if (File.separator == "/") throw new Error("FAIL: fixture missing at " + fx.nativePath);
  trace("file-listing-async: SKIPPED -- the fixture is reachable only through $HOME, which is not what File.userDirectory reads on this host");
  skip = true;
}

var listed:FileListEvent = null;
var lateListed:FileListEvent = null;
var ioErr:IOErrorEvent = null;
var cancelListed:FileListEvent = null;
function onListing(e:FileListEvent):void { listed = e; }
function onLateListing(e:FileListEvent):void { lateListed = e; }
function onCancelListing(e:FileListEvent):void { cancelListed = e; }
function onErr(e:IOErrorEvent):void { ioErr = e; }

function run():void {
// --- 1. deferred delivery, and the event's shape -----------------------------
fx.addEventListener(FileListEvent.DIRECTORY_LISTING, onListing);
fx.addEventListener(IOErrorEvent.IO_ERROR, onErr);
fx.getDirectoryListingAsync();
check(listed == null, "the call dispatches nothing synchronously");
check(ioErr == null, "…and no ioError either");

// Registered AFTER the call on purpose: this is the assertion the old inline
// dispatch could not pass, and it is how adl behaves.
fx.addEventListener(FileListEvent.DIRECTORY_LISTING, onLateListing);
tickTimers();
check(listed != null, "the listing arrives at a frame boundary");
check(lateListed != null, "a listener added after the call still receives it (adl)");

check(listed.type == FileListEvent.DIRECTORY_LISTING, "type is the DIRECTORY_LISTING constant");
check(listed.bubbles == false && listed.cancelable == false, "bubbles and cancelable are both false");
check(listed.target == fx, "target is the File the listing was asked of");

var files:Array = listed.files;
check(files.length == 5, "the fixture holds exactly 5 entries, got " + files.length);

// Membership by name, then the per-entry facts the generated File objects answer
// lazily. The fixture has a symlink to a file on purpose: isSymbolicLink is true
// for it while isDirectory still answers about the target (阶段二百六十二).
var byName:Object = {};
var names:Array = [];
for (var i:int = 0; i < files.length; i++) {
  names.push(files[i].name);
  byName[files[i].name] = files[i];
}
check(names.indexOf("a.txt") >= 0 && names.indexOf("b.txt") >= 0 && names.indexOf("sub") >= 0 && names.indexOf("link-file.txt") >= 0 && names.indexOf("noread") >= 0,
      "the listing holds a.txt, b.txt, sub, link-file.txt and noread, got [" + names.join(",") + "]");
check(byName["sub"].isDirectory == true, "sub is reported as a directory");
check(byName["a.txt"].isDirectory == false, "a.txt is reported as a file");
check(byName["link-file.txt"].isSymbolicLink == true, "the link entry answers isSymbolicLink");
check(byName["link-file.txt"].isDirectory == false, "…and isDirectory follows the link to a file");
// NOTE: read through a typed variable. 'byName["a.txt"].parent' (dynamic) answers
// null in this build while adl answers the File -- an inherited EventDispatcher
// FIELD outranks the derived class's GETTER because as_dyn_get walks every props
// table up the super chain before it touches any getters table. Pre-existing and
// unrelated to the listing contract, so it is pinned as a 遗留待开发 row
// (temp/listingprobe/) rather than asserted here.
var aEntry:File = byName["a.txt"] as File;
check(aEntry.parent.nativePath == fx.nativePath, "entries are resolved against the directory they came from");

// Order: adl's async listing uses the same enumeration as its sync one, so the
// only order claim that can be made is "the same as the sync member" -- neither
// sorts, so asserting alphabetical order would be asserting something false.
var syncNames:Array = [];
for each (var s:File in fx.getDirectoryListing()) syncNames.push(s.name);
check(names.join(",") == syncNames.join(","),
      "the async order equals the sync order [" + names.join(",") + "] vs [" + syncNames.join(",") + "]");

// --- 2. a path that does not exist: ioError #3003, no completion -------------
var missing:File = fx.resolvePath("not-there");
listed = null; ioErr = null;
missing.addEventListener(FileListEvent.DIRECTORY_LISTING, onListing);
missing.addEventListener(IOErrorEvent.IO_ERROR, onErr);
missing.getDirectoryListingAsync();
check(ioErr == null, "a missing path does not report synchronously");
tickTimers();
check(listed == null, "a missing path does NOT complete with a listing");
check(ioErr != null, "a missing path dispatches ioError");
check(ioErr.errorID == 3003, "…with errorID 3003, got " + ioErr.errorID);
check(ioErr.text == "Error #3003: File or directory does not exist.", "…and the measured short text, got [" + ioErr.text + "]");
check(ioErr.bubbles == false && ioErr.cancelable == false, "ioError bubbles/cancelable are false");

// --- 3. an existing non-directory: an EMPTY listing, not an error -----------
var notADir:File = fx.resolvePath("a.txt");
listed = null; ioErr = null;
notADir.addEventListener(FileListEvent.DIRECTORY_LISTING, onListing);
notADir.addEventListener(IOErrorEvent.IO_ERROR, onErr);
notADir.getDirectoryListingAsync();
tickTimers();
check(ioErr == null, "a non-directory is NOT an ioError for the async member");
check(listed != null && listed.files.length == 0, "a non-directory completes with an empty files array");
// The sync member does the opposite for this same input, and that asymmetry is
// measured, not a bug in either one.
var syncThrew:int = 0;
try { notADir.getDirectoryListing(); } catch (e:Error) { syncThrew = e.errorID; }
check(syncThrew == 3007, "the SYNC member throws #3007 for the same input, got " + syncThrew);

// --- 4. cancel() drops the pending listing ----------------------------------
listed = null; cancelListed = null;
fx.addEventListener(FileListEvent.DIRECTORY_LISTING, onCancelListing);
fx.getDirectoryListingAsync();
fx.cancel();
tickTimers();
check(cancelListed == null, "cancel() drops the pending listing");
tickTimers();
check(cancelListed == null, "…and it never arrives on a later boundary either");

// --- 5. a second call while one is in flight throws #2037 --------------------
listed = null;
fx.getDirectoryListingAsync();
var threw:int = 0;
try { fx.getDirectoryListingAsync(); } catch (e:Error) { threw = e.errorID; }
check(threw == 2037, "a second listing while one is in flight throws #2037, got " + threw);
tickTimers();
check(listed != null && listed.files.length == 5, "the FIRST listing still completes");

// --- 7. an UNREADABLE directory is an empty listing, NOT an error ------------
// The one odd shape that does not throw: opendir() fails with EACCES and adl
// answers an empty listing on BOTH members (measured in temp/listingprobe/).
// This is also the shape a real cleaner meets all the time, so it must not be
// mistaken for a failure. The fixture's noread directory is chmod 000.
var noread:File = fx.resolvePath("noread");
check(noread.exists == true && noread.isDirectory == true, "an unreadable directory is still stat-able");
listed = null; ioErr = null;
noread.addEventListener(FileListEvent.DIRECTORY_LISTING, onListing);
noread.addEventListener(IOErrorEvent.IO_ERROR, onErr);
noread.getDirectoryListingAsync();
tickTimers();
check(ioErr == null, "an unreadable directory is NOT an ioError (adl)");
check(listed != null && listed.files.length == 0, "…it completes with an empty listing");
var syncNoread:int = -1;
try { syncNoread = noread.getDirectoryListing().length; } catch (e:Error) { syncNoread = -2; }
check(syncNoread == 0, "the sync member agrees: an empty array, no throw, got " + syncNoread);

// --- 8. the SYNC member's own guards ----------------------------------------
// Measured side by side with the async ones above, and the two really do differ:
// the async member completes where the sync member throws.
var syncBad:int = 0;
try { missing.getDirectoryListing(); } catch (e:Error) { syncBad = e.errorID; }
check(syncBad == 3003, "sync on a missing path throws #3003, got " + syncBad);
syncBad = 0;
try { new File().getDirectoryListing(); } catch (e:Error) { syncBad = e.errorID; }
check(syncBad == 2037, "sync on an empty File throws #2037, got " + syncBad);
var syncMsg:String = "";
try { notADir.getDirectoryListing(); } catch (e:Error) { syncMsg = e.message; }
check(syncMsg == "Error #3007: Not a directory.", "and #3007's message is the measured one, got [" + syncMsg + "]");

// --- 6. an empty File: #2037 up front, not an empty listing -----------------
var empty:File = new File();
var threwEmpty:int = 0;
try { empty.getDirectoryListingAsync(); } catch (e:Error) { threwEmpty = e.errorID; }
check(threwEmpty == 2037, "new File().getDirectoryListingAsync() throws #2037, got " + threwEmpty);

trace("stage264-file-listing-async: OK");
}

if (!skip) run();
