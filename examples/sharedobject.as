// flash.net.SharedObject (stage 89·40): local persistence.
//
// AIR mode: SharedObject.getLocal() loads/saves an AMF3 ".sol" container. This
// subset writes the SAME container, under the same path, as AIR 51.4.1 (measured
// with adl): applicationStorageDirectory is scoped by the application id, and a
// local object lives at "#SharedObjects/<content path>/<name>.sol". The remote
// half (getRemote/connect/send) needs a Flash Media Server and fails loudly.
//
// A bare build (no AIR descriptor) has no <content> to nest under, so the
// directory level is empty and the path is "#SharedObjects/<name>.sol".
import flash.net.SharedObject;
import flash.net.SharedObjectFlushStatus;
import flash.net.ObjectEncoding;
import flash.filesystem.File;
import flash.filesystem.FileMode;
import flash.filesystem.FileStream;
import flash.utils.ByteArray;

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

// The path AIR derives from the name -- see as_so_path in the generated C.
function solPath(name:String):File {
  return File.applicationStorageDirectory.resolvePath("#SharedObjects/" + name + ".sol");
}
function readBytes(f:File):ByteArray {
  var fs:FileStream = new FileStream();
  fs.open(f, FileMode.READ);
  var b:ByteArray = new ByteArray();
  fs.readBytes(b);
  fs.close();
  return b;
}

var NAME:String = "as3aot-example-so";
var so:SharedObject = SharedObject.getLocal(NAME);
so.clear();

// ---- 1. data table, flush, size -------------------------------------------
expect(so.data.topScore == null, "a cleared store has no topScore (AIR: undefined, subset: null)");
expect(!solPath(NAME).exists, "clear() deletes the backing file");
// size is the byte count of the ".sol" flush() writes. adl reports 0 while the
// table holds no properties, and the exact file size once it does.
expect(so.size == 0, "an empty table reports size 0 (measured on adl)");
so.data.topScore = 42;
so.data.name = "flappy";
so.data.list = [1, 2, 3];
so.data.flag = true;
var status:String = so.flush();
expect(status == SharedObjectFlushStatus.FLUSHED, "flush() reports the FLUSHED status (got " + status + ")");
expect(so.size > 0, "size grows with the table's contents");
expect(int(so.data.topScore) == 42, "values read back through the same handle");
expect(so.data.list[1] == 2, "a stored Array survives the same-handle read");
expect(so.data.nope == null, "a missing key reads as null (AIR: undefined)");

// ---- 2. the file on disk is AIR's ".sol" container ------------------------
var f:File = solPath(NAME);
expect(f.exists, "flush() created the storage file");
var bytes:ByteArray = readBytes(f);
expect(bytes.length == so.size, "size is exactly the serialized file size (measured on adl)");
expect((bytes[0] & 255) == 0x00 && (bytes[1] & 255) == 0xBF, "the file starts with AIR's 00 BF magic");
expect(int(bytes[6]) == 0x54 && int(bytes[7]) == 0x43 && int(bytes[8]) == 0x53 && int(bytes[9]) == 0x4F,
       "the container carries the TCSO tag at offset 6");
expect(int(bytes[10]) == 0x00 && int(bytes[11]) == 0x04, "the container version is 4");
expect(int(bytes[12]) == 0 && int(bytes[13]) == 0 && int(bytes[14]) == 0 && int(bytes[15]) == 0,
       "the header's zero word follows the version");
var nameLen:int = (int(bytes[16]) << 8) | int(bytes[17]);
expect(nameLen == NAME.length, "the header stores the shared object's name length");
bytes.position = 18;
expect(bytes.readUTFBytes(nameLen) == NAME, "the header stores the shared object's name");
// Entry list: a raw U29S key (no 0x06 marker, value = (byteLength << 1) | 1) then
// an AMF3 value then 0x00, one per property. The fixed 00 00 00 03 word precedes
// them; adl writes it in every .sol it produces.
expect(int(bytes[18 + nameLen]) == 0 && int(bytes[18 + nameLen + 1]) == 0
       && int(bytes[18 + nameLen + 2]) == 0 && int(bytes[18 + nameLen + 3]) == 3,
       "the entry list opens with adl's 00 00 00 03 word");

// ---- 3. instance identity (AIR returns one instance per name) -------------
var so2:SharedObject = SharedObject.getLocal(NAME);
expect(so2 == so, "getLocal returns the same instance for the same name");
so2.data.extra = "x";
expect(so.data.extra == "x", "both handles see one data table");

// ---- 4. loading a store that already exists on disk ----------------------
// Hand-build a container the way adl does, to pin the layout independently of
// our own writer: {topScore: 99, label: "v"}.
var seedName:String = NAME + "-seeded";
var seed:ByteArray = new ByteArray();
seed.writeByte(0x00);
seed.writeByte(0xBF);
seed.writeByte(0); seed.writeByte(0); seed.writeByte(0); seed.writeByte(0);   // length, patched below
seed.writeUTFBytes("TCSO");
seed.writeByte(0x00); seed.writeByte(0x04);
seed.writeByte(0); seed.writeByte(0); seed.writeByte(0); seed.writeByte(0);
seed.writeByte(0); seed.writeByte(seedName.length);
seed.writeUTFBytes(seedName);
seed.writeByte(0); seed.writeByte(0); seed.writeByte(0); seed.writeByte(3);
seed.writeByte((8 << 1) | 1);                    // key "topScore"
seed.writeUTFBytes("topScore");
seed.writeByte(0x04); seed.writeByte(99);        // AMF3 integer
seed.writeByte(0x00);
seed.writeByte((5 << 1) | 1);                    // key "label"
seed.writeUTFBytes("label");
seed.writeByte(0x06); seed.writeByte((1 << 1) | 1); seed.writeUTFBytes("v");  // AMF3 string
seed.writeByte(0x00);
var total:int = seed.length;
seed[2] = (total - 6) >> 24 & 255;
seed[3] = (total - 6) >> 16 & 255;
seed[4] = (total - 6) >> 8 & 255;
seed[5] = (total - 6) & 255;
var seeded:File = solPath(seedName);
var wfs:FileStream = new FileStream();
wfs.open(seeded, FileMode.WRITE);
wfs.writeBytes(seed);
wfs.close();
var so3:SharedObject = SharedObject.getLocal(seedName);
expect(int(so3.data.topScore) == 99, "getLocal loads an existing .sol from disk");
expect(so3.data.label == "v", "a loaded String value keeps its value");

// ---- 4b. AIR enters dynamic property NAMES into the string table ----------
// The container has ONE AMF3 string table shared by every entry, and AIR interns
// a dynamic object's property names into it. Measured on a store adl wrote
// (temp/solread/adl-login-2617.sol): the value of "email" is the reference 14,
// which is the empty string only once "accessToken".."realname" have taken slots
// 1..13. A reader that skipped the names resolved such a reference past the end
// of its own table, dropped the object half-way, and then ABANDONED EVERY LATER
// ENTRY -- which is how a signed-in session was lost on restart: LoginView reads
// refresh_token_timer after User_Local_Info, got undefined, Number() produced NaN
// and the app called clearLoginSession(). The bytes below replay that shape, with
// "gamma" holding a reference to the name "alpha".
var dynName:String = NAME + "-dyn";
var dyn:ByteArray = new ByteArray();
dyn.writeByte(0x00);
dyn.writeByte(0xBF);
dyn.writeByte(0); dyn.writeByte(0); dyn.writeByte(0); dyn.writeByte(0);   // length, patched below
dyn.writeUTFBytes("TCSO");
dyn.writeByte(0x00); dyn.writeByte(0x04);
dyn.writeByte(0); dyn.writeByte(0); dyn.writeByte(0); dyn.writeByte(0);
dyn.writeByte(0); dyn.writeByte(dynName.length);
dyn.writeUTFBytes(dynName);
dyn.writeByte(0); dyn.writeByte(0); dyn.writeByte(0); dyn.writeByte(3);
dyn.writeByte((3 << 1) | 1); dyn.writeUTFBytes("obj");        // entry 1 key -> slot 0
dyn.writeByte(0x0A);                    // AMF3 object
dyn.writeByte(0x0B);                    // U29O: inline object + inline traits + dynamic
dyn.writeByte(0x01);                    // empty class name (raw literal, never interned)
dyn.writeByte((5 << 1) | 1); dyn.writeUTFBytes("alpha");     // name -> slot 1
dyn.writeByte(0x04); dyn.writeByte(1);
dyn.writeByte((4 << 1) | 1); dyn.writeUTFBytes("beta");      // name -> slot 2
dyn.writeByte(0x04); dyn.writeByte(2);
dyn.writeByte((5 << 1) | 1); dyn.writeUTFBytes("gamma");     // name -> slot 3
dyn.writeByte(0x06); dyn.writeByte(1 << 1);                   // string REFERENCE to slot 1 ("alpha")
dyn.writeByte(0x01);                    // empty marker: end of the dynamic members
dyn.writeByte(0x00);                    // end of the entry
dyn.writeByte((5 << 1) | 1); dyn.writeUTFBytes("timer");     // entry 2: the entry the app needs next
dyn.writeByte(0x05); dyn.writeDouble(1234.5);                 // AMF3 double
dyn.writeByte(0x00);
var dynTotal:int = dyn.length;
dyn[2] = (dynTotal - 6) >> 24 & 255;
dyn[3] = (dynTotal - 6) >> 16 & 255;
dyn[4] = (dynTotal - 6) >> 8 & 255;
dyn[5] = (dynTotal - 6) & 255;
var dynFile:File = solPath(dynName);
var dwfs:FileStream = new FileStream();
dwfs.open(dynFile, FileMode.WRITE);
dwfs.writeBytes(dyn);
dwfs.close();
var so5:SharedObject = SharedObject.getLocal(dynName);
expect(int(so5.data.obj.alpha) == 1 && int(so5.data.obj.beta) == 2,
       "dynamic members ahead of the reference are read");
expect(so5.data.obj.gamma == "alpha",
       "a reference to an earlier dynamic NAME resolves (got " + so5.data.obj.gamma + ")");
expect(so5.data.timer != null && Number(so5.data.timer) == 1234.5,
       "the entry after a dynamic object is still read (got " + so5.data.timer + ")");

// ---- 4c. the EMPTY string never takes a string-table slot -----------------
// AIR writes an empty value as the literal `06 01` every single time, so it never
// occupies a slot and every later reference is unaffected. Measured on
// temp/solread/adl-login-2617.sol: userInfo's four empty values (realname, email,
// wechat_openid, mini_program_openid) are ALL literals. Interning "" on the first
// one shifted the table: adl read an AOT-written store's "email":"" back as
// "mobile", the company objects then lost their "title"/"app_menu" keys, and
// HomeView.getTextBtn threw #2007 (Parameter text must be non-null). The bytes
// below put an empty literal BEFORE the first occurrence of "x", and "delta"
// holds a reference to "x" -- a reader that interned "" resolves it to the empty
// string instead.
var empName:String = NAME + "-empty";
var emp:ByteArray = new ByteArray();
emp.writeByte(0x00);
emp.writeByte(0xBF);
emp.writeByte(0); emp.writeByte(0); emp.writeByte(0); emp.writeByte(0);   // length, patched below
emp.writeUTFBytes("TCSO");
emp.writeByte(0x00); emp.writeByte(0x04);
emp.writeByte(0); emp.writeByte(0); emp.writeByte(0); emp.writeByte(0);
emp.writeByte(0); emp.writeByte(empName.length);
emp.writeUTFBytes(empName);
emp.writeByte(0); emp.writeByte(0); emp.writeByte(0); emp.writeByte(3);
emp.writeByte((5 << 1) | 1); emp.writeUTFBytes("alpha");      // key -> slot 0
emp.writeByte(0x06); emp.writeByte(0x01);                    // empty literal -> no slot
emp.writeByte(0x00);
emp.writeByte((4 << 1) | 1); emp.writeUTFBytes("beta");       // key -> slot 1
emp.writeByte(0x06); emp.writeByte(0x01);                    // empty literal again, still no slot
emp.writeByte(0x00);
emp.writeByte((5 << 1) | 1); emp.writeUTFBytes("gamma");      // key -> slot 2
emp.writeByte(0x06); emp.writeByte((1 << 1) | 1); emp.writeUTFBytes("x");   // "x" -> slot 3
emp.writeByte(0x00);
emp.writeByte((5 << 1) | 1); emp.writeUTFBytes("delta");      // key -> slot 4
emp.writeByte(0x06); emp.writeByte(3 << 1);                  // reference to slot 3 ("x")
emp.writeByte(0x00);
var empTotal:int = emp.length;
emp[2] = (empTotal - 6) >> 24 & 255;
emp[3] = (empTotal - 6) >> 16 & 255;
emp[4] = (empTotal - 6) >> 8 & 255;
emp[5] = (empTotal - 6) & 255;
var empFile:File = solPath(empName);
var ewfs:FileStream = new FileStream();
ewfs.open(empFile, FileMode.WRITE);
ewfs.writeBytes(emp);
ewfs.close();
var so6:SharedObject = SharedObject.getLocal(empName);
expect(so6.data.alpha == "", "an empty literal reads back as the empty string (got " + so6.data.alpha + ")");
expect(so6.data.beta == "", "a SECOND empty literal reads back as the empty string (got " + so6.data.beta + ")");
expect(so6.data.gamma == "x", "a value after two empty literals is unaffected (got " + so6.data.gamma + ")");
expect(so6.data.delta == "x",
       "an empty literal takes no slot, so a later reference still resolves (got " + so6.data.delta + ")");

// ---- 5. localPath selects a different store ------------------------------
var so4:SharedObject = SharedObject.getLocal("lp", "as3aot-example-lpdir");
expect(so4 != so, "a different name yields a different object");
so4.data.v = 1;
so4.flush();
expect(File.applicationStorageDirectory.resolvePath("#SharedObjects/as3aot-example-lpdir/lp.sol").exists,
       "localPath becomes a subdirectory of #SharedObjects");
expect(SharedObject.getLocal("lp").data.v == null, "the same name without localPath is a distinct store");

// ---- 6. clear() purges the table and deletes the file -------------------
so.clear();
expect(so.data.topScore == null, "clear() purges the table");
expect(!solPath(NAME).exists, "clear() deletes the backing file");
expect(so.size == 0, "clear() returns the table to its empty size");
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
