// file-audit.as — FileStream 的 IDataInput/IDataOutput 与 File 缺失成员的契约（阶段二百九十九·B/C 批）
// — file is examples/file-audit.as.
//
// Batches B and C of the File-family audit. Every expectation below was measured on
// adl 51.4.1 (macOS 26) first: probes temp/fileaudit2/AF.as and AG.as, outputs
// af.txt / ag.txt, plus the describeType dump in desc.txt. What this covers:
//
//   * FileStream really implements IDataInput/IDataOutput (all 23 read/write
//     members), plus endian / objectEncoding / readAhead / position. An unopened
//     stream, or the wrong side of an open one, is #2029; a read past EOF is
//     EOFError #2030; a negative position is #2006 and APPEND refuses one with
//     #2037; and opening a DIRECTORY is #3006 "Not a file." while "" is #2004.
//   * File's missing members: creationDate/modificationDate, clone, canonicalize,
//     getRelativePath, copyTo/copyToAsync, isPackage, createTempFile/
//     createTempDirectory/getRootDirectories, the url setter, and the static
//     systemCharset/cacheDirectory/workingDirectory/permissionStatus/
//     applicationRemovableStorageDirectory.
//   * The classes that did not exist at all: FileReference (File's superclass),
//     StorageVolume and StorageVolumeChangeEvent.
//
// Paths come from File.userDirectory, which reads HOME; test/examples.ts points
// HOME at a scratch directory for exactly that reason (the example creates and
// removes its own work/ tree, and dies on a half-finished one otherwise).
import flash.filesystem.File;
import flash.filesystem.FileStream;
import flash.filesystem.FileMode;
import flash.filesystem.StorageVolume;
import flash.net.FileReference;
import flash.net.FileReferenceList;
import flash.net.FileFilter;
import flash.events.FileListEvent;
import flash.events.StorageVolumeChangeEvent;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function eq(actual:Object, expected:Object, msg:String):void {
  check(String(actual) == String(expected), msg + " (got '" + actual + "', want '" + expected + "')");
}
function threw(f:Function, id:int, msg:String):Error {
  try { f(); } catch (e:Error) { eq(e.errorID, id, msg); return e; }
  throw new Error("FAIL: " + msg + " (nothing thrown)");
}
function noThrow(f:Function, msg:String):void {
  try { f(); } catch (e:Error) { throw new Error("FAIL: " + msg + " (threw #" + e.errorID + ": " + e.message + ")"); }
}
function endsWith(s:String, tail:String):Boolean {
  return s.length >= tail.length && s.substr(s.length - tail.length) == tail;
}
// The bytes of a file as lower-case hex, read through FileStream itself.
function hexOf(f:File):String {
  var s:FileStream = new FileStream();
  s.open(f, FileMode.READ);
  var out:String = "";
  for (var i:int = 0; i < f.size; i++) {
    var h:String = s.readUnsignedByte().toString(16);
    if (h.length < 2) h = "0" + h;
    out += h;
  }
  s.close();
  return out;
}

var home:File = File.userDirectory;
var work:File = home.resolvePath("audit-work");
if (work.exists) work.deleteDirectory(true);
work.createDirectory();

// ============================================================== FileStream
// Defaults, measured on adl 51.4.1 (af.txt 1-3).
var z:FileStream = new FileStream();
eq(z.endian, "bigEndian", "a fresh FileStream reads big-endian");
eq(z.objectEncoding, 3, "a fresh FileStream is AMF3");
eq(z.readAhead, Infinity, "readAhead defaults to Infinity");
z.readAhead = 42;
eq(z.readAhead, 42, "readAhead is settable");

// Everything on an unopened stream is #2029, except close() (af.txt 4-9).
threw(function():void { var v:* = z.bytesAvailable; }, 2029, "bytesAvailable needs an open stream");
threw(function():void { var v:* = z.position; }, 2029, "position needs an open stream");
threw(function():void { z.readByte(); }, 2029, "readByte needs an open stream");
threw(function():void { z.writeByte(1); }, 2029, "writeByte needs an open stream");
threw(function():void { z.truncate(); }, 2029, "truncate needs an open stream");
noThrow(function():void { z.close(); }, "close on an unopened stream is a no-op");

// A full scalar round trip. The size is a fixed 31 bytes on 51.4.1: int 4 +
// short 2 + float 4 + double 8 + writeUTF("héllo" = 6 UTF-8 bytes + 2) +
// boolean 1 + uint 4.
var scalars:File = work.resolvePath("scalars.bin");
var w:FileStream = new FileStream();
w.open(scalars, FileMode.WRITE);
w.writeInt(305419896);        // 0x12345678
w.writeShort(-2);
w.writeFloat(1.5);
w.writeDouble(Math.PI);
w.writeUTF("héllo");
w.writeBoolean(true);
w.writeUnsignedInt(4000000000);
w.close();
eq(scalars.size, 31, "the scalar file is 31 bytes");
var r:FileStream = new FileStream();
r.open(scalars, FileMode.READ);
eq(r.readInt(), 305419896, "readInt round-trips");
eq(r.readShort(), -2, "readShort round-trips (signed)");
eq(r.readFloat(), 1.5, "readFloat round-trips");
eq(r.readDouble(), Math.PI, "readDouble round-trips");
eq(r.readUTF(), "héllo", "readUTF round-trips UTF-8");
eq(r.readBoolean(), true, "readBoolean round-trips");
eq(r.readUnsignedInt(), 4000000000, "readUnsignedInt round-trips a value above int.MAX");
eq(r.bytesAvailable, 0, "the stream is drained");

// Endianness applies to the multi-byte members only (af.txt 10).
var endianFile:File = work.resolvePath("endian.bin");
var ew:FileStream = new FileStream();
ew.open(endianFile, FileMode.WRITE);
ew.writeInt(16909060);        // 0x01020304, big endian by default
ew.endian = "littleEndian";
ew.writeInt(16909060);
ew.close();
eq(hexOf(endianFile), "0102030404030201", "writeInt honours endian");

// A read past EOF is EOFError #2030, never a short read (af.txt 11-12).
var er:FileStream = new FileStream();
er.open(scalars, FileMode.READ);
er.position = scalars.size;
threw(function():void { er.readByte(); }, 2030, "readByte past EOF is #2030");
var er2:FileStream = new FileStream();
er2.open(scalars, FileMode.READ);
threw(function():void { er2.readUTFBytes(1000); }, 2030, "an over-long readUTFBytes is #2030");

// position: negative is #2006, APPEND refuses it with #2037 (af.txt 13-16).
threw(function():void { er.position = -1; }, 2006, "a negative position is #2006");
var ap:File = work.resolvePath("append.bin");
var aw:FileStream = new FileStream();
aw.open(ap, FileMode.WRITE); aw.writeUTFBytes("abcdef"); aw.close();
var ar:FileStream = new FileStream();
ar.open(ap, FileMode.APPEND);
eq(ar.position, 6, "APPEND opens at EOF");
threw(function():void { ar.position = 0; }, 2037, "APPEND refuses a position set");
ar.close();

// UPDATE reads and writes the whole file, and truncate() cuts at the position.
var up:FileStream = new FileStream();
up.open(ap, FileMode.UPDATE);
eq(up.bytesAvailable, 6, "UPDATE makes the whole file available");
up.position = 2;
up.writeUTFBytes("Z");
up.close();
var chk:FileStream = new FileStream();
chk.open(ap, FileMode.READ);
eq(chk.readUTFBytes(6), "abZdef", "the UPDATE write landed at the position");
chk.close();
var tr:FileStream = new FileStream();
tr.open(ap, FileMode.UPDATE);
tr.position = 2;
tr.truncate();
tr.close();
eq(ap.size, 2, "truncate() cuts the file at the position");

// bytesAvailable is a READ-side answer (af.txt 8).
threw(function():void {
  var q:FileStream = new FileStream();
  q.open(work.resolvePath("w2.bin"), FileMode.WRITE);
  var v:* = q.bytesAvailable;
  q.close();
}, 2029, "bytesAvailable on a WRITE handle is #2029");

// The open() contract (af.txt 18-23): a directory is #3006 "Not a file.", "" is
// #2004, a missing path is #3003 only for READ/UPDATE (WRITE creates the file),
// and a null mode behaves as READ.
threw(function():void { var q:FileStream = new FileStream(); q.open(work, FileMode.READ); }, 3006, "open on a directory is #3006");
threw(function():void { var q:FileStream = new FileStream(); q.open(scalars, ""); }, 2004, "open with an empty mode is #2004");
threw(function():void { var q:FileStream = new FileStream(); q.open(work.resolvePath("missing.bin"), FileMode.READ); }, 3003, "open a missing file for reading is #3003");
noThrow(function():void {
  var q:FileStream = new FileStream();
  q.open(scalars, null);
  eq(q.bytesAvailable, 31, "open(f, null) reads");
  q.close();
}, "open(f, null) behaves as READ");
var created:File = work.resolvePath("created.bin");
noThrow(function():void { var q:FileStream = new FileStream(); q.open(created, FileMode.WRITE); q.close(); }, "WRITE creates the file");
check(created.exists, "WRITE really created it");

// Object encoding: AMF3 by default, AMF0 on request (af.txt 24-25).
var amf:File = work.resolvePath("amf.bin");
var ow:FileStream = new FileStream();
ow.open(amf, FileMode.WRITE);
ow.writeObject({ a: 1, b: "x" });
ow.close();
var orr:FileStream = new FileStream();
orr.open(amf, FileMode.READ);
var obj:Object = orr.readObject();
orr.close();
eq(obj.a, 1, "readObject returns the AMF3 payload");
eq(obj.b, "x", "readObject returns the AMF3 string");
// objectEncoding is a real settable property; AMF0 SERIALISATION itself is a
// pre-existing gap of this build's codec (registered in TODO.md -- the encoder
// reports itself instead of writing AMF3 bytes under an AMF0 label), so only the
// property is pinned here.
orr = new FileStream();
orr.objectEncoding = 0;
eq(orr.objectEncoding, 0, "objectEncoding accepts AMF0");
orr.close();

// writeMultiByte/readMultiByte through the shared charset codec.
var mb:File = work.resolvePath("mb.bin");
var mw:FileStream = new FileStream();
mw.open(mb, FileMode.WRITE);
mw.writeMultiByte("abc", "utf-8");
mw.close();
var mr:FileStream = new FileStream();
mr.open(mb, FileMode.READ);
eq(mr.readMultiByte(mb.size, "utf-8"), "abc", "writeMultiByte/readMultiByte round-trip");
mr.close();

// Byte-array transfer members.
var baSrc:ByteArray = new ByteArray();
baSrc.writeUTFBytes("XY");
var baFile:File = work.resolvePath("bytes.bin");
var bw:FileStream = new FileStream();
bw.open(baFile, FileMode.WRITE);
bw.writeBytes(baSrc);
bw.close();
eq(baFile.size, 2, "writeBytes writes the array length");
var baDst:ByteArray = new ByteArray();
var br:FileStream = new FileStream();
br.open(baFile, FileMode.READ);
br.readBytes(baDst);
br.close();
eq(baDst.length, 2, "readBytes(0) reads to EOF");
eq(baDst.readUTFBytes(2), "XY", "the bytes survived the round trip");

// ============================================================== File members
// creationDate / modificationDate (af.txt 31-34).
check(scalars.creationDate is Date, "creationDate is a Date");
check(scalars.modificationDate.time >= scalars.creationDate.time, "modificationDate is not earlier than creationDate");
threw(function():void { var v:* = work.resolvePath("nope.bin").creationDate; }, 3003, "creationDate on a missing path is #3003");
threw(function():void { var v:* = new File(null).creationDate; }, 2037, "creationDate on an empty File is #2037");

// clone() (af.txt 35).
var cl:File = scalars.clone();
check(cl != scalars, "clone() returns a different object");
eq(cl.nativePath, scalars.nativePath, "clone() keeps the path");

// canonicalize(): a path that exists is resolved, one that does not is untouched
// (measured in AG.as).
if (File.separator == "/") {
  noThrow(function():void { new File("/tmp").canonicalize(); }, "canonicalize() on an existing path");
  var ghost:File = new File("/tmp/asaot-ghost/deep/none.txt");
  ghost.canonicalize();
  eq(ghost.nativePath, "/tmp/asaot-ghost/deep/none.txt", "canonicalize() leaves a nonexistent path alone");
}

// getRelativePath(): FROM the receiver TO the argument (af.txt 36-40).
var kid:File = work.resolvePath("kid.txt");
eq(work.getRelativePath(kid), "kid.txt", "getRelativePath down to a child");
eq(kid.getRelativePath(work, true), "..", "getRelativePath up to the parent needs useDotDot");
eq(kid.getRelativePath(work), null, "without useDotDot the answer is null");
eq(work.getRelativePath(work), "", "the same path is the empty string");
var unrelated:File = new File("/etc/hosts");
eq(work.getRelativePath(unrelated), null, "an unrelated path without useDotDot is null");

// copyTo (af.txt 41-48).
var src:File = work.resolvePath("src.txt");
var sw:FileStream = new FileStream();
sw.open(src, FileMode.WRITE); sw.writeUTFBytes("0123456789"); sw.close();
var dst:File = work.resolvePath("dst.txt");
noThrow(function():void { src.copyTo(dst); }, "copyTo a new path");
eq(dst.size, 10, "the copy has the source's bytes");
threw(function():void { src.copyTo(dst); }, 3012, "copyTo onto an existing target without overwrite is #3012");
var dst2:File = work.resolvePath("dst2.txt");
var sw2:FileStream = new FileStream();
sw2.open(dst2, FileMode.WRITE); sw2.writeUTFBytes("old"); sw2.close();
noThrow(function():void { src.copyTo(dst2, true); }, "copyTo with overwrite");
eq(dst2.size, 10, "the overwritten copy is the source's size");
threw(function():void { work.resolvePath("gone.txt").copyTo(work.resolvePath("x.txt")); }, 3003, "copyTo from a missing source is #3003");
threw(function():void { src.copyTo(null); }, 2007, "copyTo(null) is #2007");
var tree:File = work.resolvePath("tree");
tree.resolvePath("a/b").createDirectory();
var dfw:FileStream = new FileStream();
dfw.open(tree.resolvePath("a/b/deep.txt"), FileMode.WRITE); dfw.writeUTFBytes("d"); dfw.close();
var tree2:File = work.resolvePath("tree2");
noThrow(function():void { tree.copyTo(tree2); }, "copyTo a directory tree");
check(tree2.resolvePath("a/b/deep.txt").exists, "the copied tree keeps its shape");
eq(tree2.resolvePath("a/b/deep.txt").size, 1, "the copied leaf kept its bytes");

// isPackage: a DIRECTORY with a bundle extension, not a file (af.txt 49-51).
var pkg:File = work.resolvePath("x.app");
pkg.createDirectory();
check(pkg.isPackage, "a directory named .app is a package");
var fw:File = work.resolvePath("y.framework");
fw.createDirectory();
check(!fw.isPackage, ".framework is not a package");
var pkgFile:File = work.resolvePath("z.app");
var pw:FileStream = new FileStream();
pw.open(pkgFile, FileMode.WRITE); pw.writeUTFBytes("x"); pw.close();
check(!pkgFile.isPackage, "a FILE named .app is not a package");

// The three statics and the temp helpers (af.txt 52-55).
var tf:File = File.createTempFile();
check(tf.exists, "createTempFile() creates the file");
check(tf.nativePath.indexOf("FlashTmp.") >= 0, "createTempFile() uses AIR's FlashTmp. prefix");
var td:File = File.createTempDirectory();
check(td.isDirectory, "createTempDirectory() creates a directory");
var roots:Array = File.getRootDirectories();
check(roots.length >= 1, "getRootDirectories() is not empty");
if (File.separator == "/") eq(roots[0].nativePath, "/", "POSIX has exactly one root");

// The url setter (af.txt 56-61): file: is decoded, app: resolves against the
// application directory, and null/""/http are all #2004.
var u:File = new File("/tmp/zzz.txt");
u.url = "file:///tmp/aaa%20b.txt";
eq(u.nativePath, "/tmp/aaa b.txt", "url decodes percent escapes");
threw(function():void { u.url = null; }, 2004, "url = null is #2004");
threw(function():void { u.url = ""; }, 2004, "url = \"\" is #2004");
threw(function():void { u.url = "http://x/y.txt"; }, 2004, "url = http: is #2004");
u.url = "app:/q.txt";
check(endsWith(u.nativePath, "/q.txt"), "url = app:/ resolves against the app directory");

// The FileReference-shaped reads on a real File (af.txt 62-66).
eq(src.creator, null, "creator is null for a real file");
eq(src.data, null, "data is null -- only a FileReference load fills it");
eq(src.preventBackup, false, "preventBackup starts false");
src.preventBackup = true;
eq(src.preventBackup, false, "AIR does not honour preventBackup on macOS, and neither do we");
eq(src.downloaded, false, "a file we just wrote is not quarantined");
check(src.icon != null, "icon is an Icon object (this build has no artwork to put in it)");

// File's static system reads (af.txt 67-72).
eq(File.separator, "/", "POSIX separator");
eq(File.lineEnding, "\n", "POSIX line ending");
eq(File.permissionStatus, "granted", "file access is not gated on macOS");
check(File.systemCharset != null && File.systemCharset.length > 0, "systemCharset is a string");
check(endsWith(File.cacheDirectory.nativePath, "Library/Caches"), "cacheDirectory is ~/Library/Caches");
eq(File.applicationRemovableStorageDirectory, null, "there is no removable-storage directory here");

// ============================================================== FileReference
// A FileReference that never browsed has no file: every accessor is #2037 except
// data, which is null (af.txt 73-79).
var fr:FileReference = new FileReference();
eq(fr.toString(), "[object FileReference]", "FileReference's toString");
threw(function():void { var v:* = fr.name; }, 2037, "name without a chooser result is #2037");
threw(function():void { var v:* = fr.size; }, 2037, "size without a chooser result is #2037");
threw(function():void { var v:* = fr.creationDate; }, 2037, "creationDate without a chooser result is #2037");
threw(function():void { var v:* = fr.creator; }, 2037, "creator without a chooser result is #2037");
eq(fr.data, null, "data without a chooser result is null");
noThrow(function():void { fr.cancel(); }, "cancel() with nothing in flight is a no-op");

// FileReferenceList starts with a NULL fileList -- not an empty Array -- and
// fileList is read-only (measured in AH.as). Nothing can fill it here, since this
// build has no native multi-select dialog.
var frl:FileReferenceList = new FileReferenceList();
eq(frl.toString(), "[object FileReferenceList]", "FileReferenceList's toString");
eq(frl.fileList, null, "fileList starts out null");
noThrow(function():void { frl.addEventListener(FileListEvent.SELECT_MULTIPLE, function(e:FileListEvent):void {}); }, "FileReferenceList is an EventDispatcher");

// FileFilter is a plain three-value class (af.txt 82).
var filter:FileFilter = new FileFilter("Text", "*.txt", "TEXT");
eq(filter.description, "Text", "FileFilter.description");
eq(filter.extension, "*.txt", "FileFilter.extension");
eq(filter.macType, "TEXT", "FileFilter.macType");

// FileListEvent carries a files array and two constants.
var listEvent:FileListEvent = new FileListEvent(FileListEvent.DIRECTORY_LISTING, false, false, [src]);
eq(listEvent.type, "directoryListing", "FileListEvent.DIRECTORY_LISTING");
eq(listEvent.files.length, 1, "FileListEvent.files");

// =================================================== StorageVolume + event
// The constructor takes (rootDirectory, name, isWritable, isRemovable,
// fileSystemType, drive) — measured by reading the six getters back (AF.as).
var vol:StorageVolume = new StorageVolume(new File("/"), "Macintosh HD", true, false, "apfs", "/");
eq(vol.rootDirectory.nativePath, "/", "StorageVolume.rootDirectory");
eq(vol.name, "Macintosh HD", "StorageVolume.name");
eq(vol.isWritable, true, "StorageVolume.isWritable");
eq(vol.isRemovable, false, "StorageVolume.isRemovable");
eq(vol.fileSystemType, "apfs", "StorageVolume.fileSystemType");
eq(vol.drive, "/", "StorageVolume.drive");

var ev:StorageVolumeChangeEvent = new StorageVolumeChangeEvent(
  StorageVolumeChangeEvent.STORAGE_VOLUME_MOUNT, false, false, new File("/"), vol);
eq(StorageVolumeChangeEvent.STORAGE_VOLUME_MOUNT, "storageVolumeMount", "STORAGE_VOLUME_MOUNT");
eq(StorageVolumeChangeEvent.STORAGE_VOLUME_UNMOUNT, "storageVolumeUnmount", "STORAGE_VOLUME_UNMOUNT");
eq(ev.type, "storageVolumeMount", "the event keeps its type");
eq(ev.rootDirectory.nativePath, "/", "the event carries the root directory");
eq(ev.storageVolume.name, "Macintosh HD", "the event carries the volume");
var ev2:StorageVolumeChangeEvent = ev.clone() as StorageVolumeChangeEvent;
eq(ev2.type, "storageVolumeMount", "clone() keeps the type");
eq(ev2.storageVolume.name, "Macintosh HD", "clone() keeps the volume");

// Leave the scratch tree as we found it.
if (work.exists) work.deleteDirectory(true);
trace("file-audit: OK");