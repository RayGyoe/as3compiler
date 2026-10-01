// flash.net.SharedObject (stage 89·40): local persistence.
//
// AIR mode: SharedObject.getLocal() loads/saves an AMF3 ".sol" container. This
// subset persists the same `data` table as JSON under
// applicationStorageDirectory, so the bytes differ while the observable
// semantics (identity, flush, clear, size, client) match AIR 51.4.1 as measured
// with adl. The remote half (getRemote/connect/send) needs a Flash Media Server
// and fails loudly.
import flash.net.SharedObject;
import flash.net.SharedObjectFlushStatus;
import flash.net.ObjectEncoding;
import flash.filesystem.File;
import flash.filesystem.FileStream;

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var NAME:String = "as3aot-example-so";
var so:SharedObject = SharedObject.getLocal(NAME);
so.clear();

// ---- 1. data table, flush, size -------------------------------------------
expect(so.data.topScore == null, "a cleared store has no topScore (AIR: undefined, subset: null)");
expect(!File.applicationStorageDirectory.resolvePath(NAME + ".json").exists,
       "clear() deletes the backing file");
// size is the byte count of the persisted representation — what flush() writes.
var emptySize:uint = so.size;
expect(emptySize > 0 && emptySize <= 4, "an empty table serializes to the 2-byte empty JSON object (AIR's AMF container is larger)");
so.data.topScore = 42;
so.data.name = "flappy";
so.data.list = [1, 2, 3];
so.data.flag = true;
var status:String = so.flush();
expect(status == SharedObjectFlushStatus.FLUSHED, "flush() reports the FLUSHED status (got " + status + ")");
expect(so.size > emptySize, "size grows with the table's contents");
expect(int(so.data.topScore) == 42, "values read back through the same handle");
expect(so.data.list[1] == 2, "a stored Array survives the same-handle read");
expect(so.data.nope == null, "a missing key reads as null (AIR: undefined)");

// ---- 2. the file on disk really holds the data ----------------------------
var f:File = File.applicationStorageDirectory.resolvePath(NAME + ".json");
expect(f.exists, "flush() created the storage file");
var fs:FileStream = new FileStream();
fs.open(f, "read");
var text:String = fs.readUTFBytes(so.size);   // flush() writes exactly the serialized table
fs.close();
expect(text.indexOf("topScore") >= 0 && text.indexOf("42") >= 0, "the persisted file contains the flushed value");
expect(text.indexOf("flappy") >= 0, "String values are persisted as well");

// ---- 3. instance identity (AIR returns one instance per name) -------------
var so2:SharedObject = SharedObject.getLocal(NAME);
expect(so2 == so, "getLocal returns the same instance for the same name");
so2.data.extra = "x";
expect(so.data.extra == "x", "both handles see one data table");

// ---- 4. loading a store that already exists on disk ----------------------
var seeded:File = File.applicationStorageDirectory.resolvePath(NAME + "-seeded.json");
fs.open(seeded, "write");
fs.writeUTFBytes('{"topScore":99,"name":"seeded","nested":{"a":1},"arr":[7,8]}');
fs.close();
var so3:SharedObject = SharedObject.getLocal(NAME + "-seeded");
expect(int(so3.data.topScore) == 99, "getLocal loads an existing store from disk");
expect(so3.data.name == "seeded", "loaded String values keep their value");
expect(int(so3.data.nested.a) == 1, "a loaded nested Object is reachable");
expect(int(so3.data.arr[0]) == 7, "a loaded Array is reachable");

// ---- 5. localPath selects a different store ------------------------------
var so4:SharedObject = SharedObject.getLocal("lp", "as3aot-example-lpdir");
expect(so4 != so, "a different name yields a different object");
so4.data.v = 1;
so4.flush();
expect(File.applicationStorageDirectory.resolvePath("as3aot-example-lpdir/lp.json").exists,
       "localPath becomes a subdirectory of the storage directory");
expect(SharedObject.getLocal("lp").data.v == null, "the same name without localPath is a distinct store");

// ---- 6. clear() purges the table and deletes the file -------------------
so.clear();
expect(so.data.topScore == null, "clear() purges the table");
expect(!File.applicationStorageDirectory.resolvePath(NAME + ".json").exists, "clear() deletes the backing file");
expect(so.size == emptySize, "clear() returns the table to its empty size");
so.data.after = 7;
so.flush();
expect(int(so.data.after) == 7 && so.size > 0, "the object stays usable after clear() and re-flushes");

// ---- 7. accessors, constants, defaults ----------------------------------
expect(so.client == so, "the default client is the shared object itself");
expect(so.objectEncoding == ObjectEncoding.AMF3, "a new object starts in the default encoding");
expect(ObjectEncoding.AMF0 == 0 && ObjectEncoding.AMF3 == 3 && ObjectEncoding.DEFAULT == 3,
       "ObjectEncoding holds the AIR constant values");
expect(SharedObject.defaultObjectEncoding == 3, "defaultObjectEncoding is AMF3");
expect(SharedObjectFlushStatus.PENDING == "pending", "SharedObjectFlushStatus.PENDING is \"pending\"");
var saved:uint = SharedObject.defaultObjectEncoding;
SharedObject.defaultObjectEncoding = ObjectEncoding.AMF0;
var soEnc:SharedObject = SharedObject.getLocal(NAME + "-enc");
expect(soEnc.objectEncoding == ObjectEncoding.AMF0, "defaultObjectEncoding affects later objects");
SharedObject.defaultObjectEncoding = saved;

// ---- 8. setProperty writes through to data ------------------------------
so.setProperty("sp", 5);
expect(int(so.data.sp) == 5, "setProperty writes the data table");
so.close();
expect(int(so.data.after) == 7, "close() leaves a local object intact (AIR: remote only)");

// ---- 9. the remote half fails loudly ------------------------------------
var threw:Boolean = false;
try { SharedObject.getRemote("r", null); } catch (e:Error) { threw = true; }
expect(threw, "getRemote throws without a Flash Media Server");

trace("sharedobject: all assertions passed");