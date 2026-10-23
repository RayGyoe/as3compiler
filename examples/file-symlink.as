// stage262-file-symlink.as — File.isSymbolicLink (阶段二百六十二)
// — file is examples/file-symlink.as.
//
// File.isSymbolicLink is the ONE predicate in the File family that does not follow
// the link: it goes through lstat() (POSIX) / FILE_ATTRIBUTE_REPARSE_POINT
// (Windows), while exists / isDirectory / size / spaceAvailable all go through
// stat() and therefore answer about the TARGET. The two are not alternatives --
// for a symlink to a directory BOTH isDirectory and isSymbolicLink are true, and a
// dangling link has exists == false while isSymbolicLink == true.
//
// The measurements this example pins were taken on adl 51.4.1 (macOS 26, probe in
// temp/symprobe/) by running one probe through mxmlc + adl and the other through
// this compiler, then comparing line by line:
//   * link -> dir      : exists true,  isDirectory TRUE,  isSymbolicLink TRUE
//   * link -> file     : exists true,  isDirectory false, isSymbolicLink TRUE
//   * dangling link    : exists FALSE, isDirectory false, isSymbolicLink TRUE
//   * real dir / file  : exists true,  isSymbolicLink false
//   * a path that does not exist at all: everything false
//   * a cyclic link -> its own ancestor : isSymbolicLink true (this is the case
//     that makes the guard load-bearing -- see the walk below)
//
// Why the member exists at all: the macOS cleaner `prune` (workspace root) sized
// ~/Library/Caches recursively and reported 124 GB where du says 7.6 GB, because
// that tree contains .framework/Versions/Current-style links back into sibling
// directories and the walk followed every one of them. With this predicate the walk
// stops at a link -- which is also what du does by default -- and the number it
// prints is the number on disk.
//
// The walk assertions below are the point of the member, not decoration: the guarded
// walk must land on an EXACT node/link/byte count (4 real nodes, 4 links skipped,
// 8 bytes), and the unguarded one must be shown to visit the tree more than once and
// report more bytes than it holds. If a future change made isSymbolicLink answer false
// for everything, the guarded walk would stop being bounded and this example would fail
// loudly instead of quietly over-reporting by 16x.
//
// The suite runs this example with HOME pointed at temp/sym-home (see EXAMPLE_ENV in
// test/examples.ts), whose `fx/` tree is built with node:fs right before the run --
// git cannot store a symlink to `.` reliably, and the fixture has to be recreated
// fresh so a half-finished earlier run cannot leave it wrong.
import flash.filesystem.File;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// The one thing a size walk asks of a path here: is it a real directory we may enter?
// `true` only for a directory that is not itself a link.
function enterable(f:File):Boolean { return f.isDirectory && !f.isSymbolicLink; }

// Bounded walk. followLinks=false is the product rule (a link is not a payload and is
// not descended into); followLinks=true is the shape that inflates the number. The cap
// is a safety net so a walk that goes wild on some other filesystem cannot hang the
// suite -- on macOS the kernel's 32-link ELOOP ceiling ends the runaway first, which is
// why the assertions below are about how MANY nodes and bytes are visited, not about
// hitting the cap.
function walk(root:File, followLinks:Boolean, cap:int):Object {
  var nodes:int = 1, links:int = 0, bytes:Number = 0;
  var stack:Array = [root];
  while (stack.length > 0) {
    if (nodes + links >= cap) return { nodes: nodes, links: links, bytes: bytes, capped: true };
    var d:File = stack.pop();
    for each (var c:File in d.getDirectoryListing()) {
      if (c.isSymbolicLink && !followLinks) {
        links++;
      } else if (c.isDirectory) {
        nodes++;
        stack.push(c);
      } else {
        nodes++;
        bytes += c.size;
      }
    }
  }
  return { nodes: nodes, links: links, bytes: bytes, capped: false };
}

var fx:File = File.userDirectory.resolvePath("fx");

// $HOME is what File.userDirectory reads here; on Windows it reads USERPROFILE, and if
// the fixture is not reachable there, say so out loud rather than passing on a run that
// asserted nothing. On POSIX the harness guarantees the fixture exists, so a missing one
// is a hard failure.
var skip:Boolean = false;
if (!fx.exists) {
  if (File.separator == "/") throw new Error("FAIL: fixture missing at " + fx.nativePath);
  trace("file-symlink: SKIPPED -- the fixture is reachable only through $HOME, which is not what File.userDirectory reads on this host");
  skip = true;
}

function run():void {
  var dir:File = fx.resolvePath("sub");
  var file:File = fx.resolvePath("real.txt");
  var linkDir:File = fx.resolvePath("link-dir");
  var linkFile:File = fx.resolvePath("link-file.txt");
  var dangling:File = fx.resolvePath("dangling");
  var absent:File = fx.resolvePath("not-there");
  var cycle:File = fx.resolvePath("loop");

  // --- the two families, side by side -----------------------------------------
  check(dir.exists && dir.isDirectory && !dir.isSymbolicLink, "real directory: exists, isDirectory, NOT a link");
  check(file.exists && !file.isDirectory && !file.isSymbolicLink, "real file: exists, not a directory, NOT a link");

  // The pair that is the whole point: following and not following are two different
  // questions, and a symlinked directory answers yes to both.
  check(linkDir.exists, "link -> dir: exists is TRUE (stat follows)");
  check(linkDir.isDirectory, "link -> dir: isDirectory is TRUE (stat follows)");
  check(linkDir.isSymbolicLink, "link -> dir: isSymbolicLink is TRUE (lstat does not)");

  check(linkFile.exists && !linkFile.isDirectory, "link -> file: exists, not a directory");
  check(linkFile.isSymbolicLink, "link -> file: isSymbolicLink is TRUE");

  // A dangling link separates the two in the other direction: the target is gone,
  // the link is not.
  check(!dangling.exists, "dangling link: exists is FALSE");
  check(!dangling.isDirectory, "dangling link: isDirectory is FALSE");
  check(dangling.isSymbolicLink, "dangling link: isSymbolicLink is TRUE");

  // Not "unsupported", not "unknown" -- a plain false. And a link that was never
  // followed still answers about itself, so the walk above can ask before descending.
  check(!absent.exists && !absent.isDirectory && !absent.isSymbolicLink, "absent path: all three are FALSE");
  check(cycle.isSymbolicLink && cycle.isDirectory, "cyclic link: isSymbolicLink is TRUE and isDirectory is TRUE");

  check(enterable(dir) && enterable(fx), "enterable: real directories qualify");
  check(!enterable(linkDir) && !enterable(cycle), "enterable: links do not, even when they point at a directory");

  // --- and now the reason it has to be checked before descending --------------
  // fx holds 6 entries: sub/ (real dir), real.txt, link-file.txt, link-dir, dangling,
  // loop -- four of the six are links.
  var guarded:Object = walk(fx, false, 5000);
  check(guarded.capped == false, "guarded walk terminates on a tree that contains a cycle");
  check(guarded.nodes == 4, "guarded walk counts exactly the 4 real entries (fx, sub, real.txt, sub/inner.txt), got " + guarded.nodes);
  check(guarded.links == 4, "guarded walk skips exactly the 4 links, got " + guarded.links);
  check(guarded.bytes == 8, "guarded walk sums exactly the 8 real bytes, got " + guarded.bytes);

  var unguarded:Object = walk(fx, true, 2000);
  // On macOS the kernel's own ELOOP ceiling (32 links) stops the runaway depth before
  // our cap does, so what is asserted here is the duplication rather than a hang: the
  // guard does not exist to keep the walk finite, it exists to keep it TRUE.
  check(unguarded.nodes > guarded.nodes, "unguarded walk re-enters directories it has already counted (a link to sub is a second visit), got " + unguarded.nodes);
  check(unguarded.bytes > guarded.bytes, "\u2026and so reports more bytes than the tree holds -- this is how 7.6 GB of cache became 124 GB, got " + unguarded.bytes);

  trace("stage262-file-symlink: OK");
}

if (!skip) run();
