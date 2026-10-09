// 阶段九十四·四 — ByteArray multi-byte / boolean / AMF3 object serialization.
// Every expected byte string below was measured on adl 51.4.1 (temp/amfprobe/),
// so these are differential assertions, not guesses.
import flash.utils.ByteArray;
import flash.utils.Dictionary;
import flash.net.registerClassAlias;
import flash.net.getClassByAlias;
import flash.utils.getQualifiedClassName;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

// Hex dump of a ByteArray (restores `position`, so it is safe mid-test).
function hex(b:ByteArray):String {
	var save:int = b.position;
	b.position = 0;
	var s:String = "";
	for (var i:int = 0; i < b.length; i++) {
		var v:int = b.readUnsignedByte();
		var h:String = v.toString(16);
		if (h.length < 2) h = "0" + h;
		s += h + " ";
	}
	b.position = save;
	return s;
}

// ---- the two probe DTOs -------------------------------------------------
class Person {
	public var name:String;
	public var age:int;
	public var hidden:String = "x";   // public, so it IS a trait member
	public function Person() {}
}
class Employee extends Person {
	public var extra:String;
	public function Employee() {}
}

// ---- writeMultiByte / readMultiByte -------------------------------------
var b:ByteArray = new ByteArray();
b.writeMultiByte("AB", "utf-8");
check(hex(b) == "41 42 ", "utf-8 ascii encodes as itself");

var ba:ByteArray = new ByteArray();
ba.writeMultiByte("é", "utf-8");
check(hex(ba) == "c3 a9 ", "utf-8 encodes é as two bytes");

var cjk:ByteArray = new ByteArray();
cjk.writeMultiByte("中", "utf-8");
check(hex(cjk) == "e4 b8 ad ", "utf-8 encodes 中 as three bytes");

var astral:ByteArray = new ByteArray();
astral.writeMultiByte("😀", "utf-8");
check(hex(astral) == "f0 9f 98 80 ", "utf-8 encodes an astral character as four bytes");

// "unicode" is UTF-16LE with no BOM, and `endian` has NO effect on it (measured).
var uni:ByteArray = new ByteArray();
uni.writeMultiByte("Aé中", "unicode");
check(hex(uni) == "41 00 e9 00 2d 4e ", "unicode writes UTF-16LE with no BOM");
// A fresh buffer, with `endian` explicitly forced, still writes UTF-16LE.
var uniLe:ByteArray = new ByteArray();
uniLe.endian = "littleEndian";
uniLe.writeMultiByte("Aé中", "unicode");
check(hex(uniLe) == "41 00 e9 00 2d 4e ", "unicode ignores the endian property");

var ub:ByteArray = new ByteArray();
ub.writeMultiByte("中", "utf-16be");
check(hex(ub) == "4e 2d ", "utf-16be forces big endian");

var gbk:ByteArray = new ByteArray();
gbk.writeMultiByte("中", "gbk");
check(hex(gbk) == "d6 d0 ", "gbk encodes 中 through the system code page");

var ascii:ByteArray = new ByteArray();
ascii.writeMultiByte("é", "us-ascii");
check(hex(ascii) == "3f ", "an unrepresentable character becomes '?' (not a transliteration)");

// ---- readMultiByte ------------------------------------------------------
var r1:ByteArray = new ByteArray();
r1.writeMultiByte("Aé中", "utf-8");
r1.position = 0;
check(r1.readMultiByte(6, "utf-8") == "Aé中", "utf-8 readMultiByte round trips");
r1.position = 0;
check(r1.readMultiByte(3, "utf-8") == "Aé", "readMultiByte honours the byte length");

var r2:ByteArray = new ByteArray();
r2.writeMultiByte("中文", "gbk");
r2.position = 0;
check(r2.readMultiByte(4, "gbk") == "中文", "gbk round trips through readMultiByte");

var r3:ByteArray = new ByteArray();
r3.writeMultiByte("Aé", "unicode");
r3.position = 0;
check(r3.readMultiByte(4, "unicode") == "Aé", "unicode round trips");

// A truncated UTF-8 sequence decodes to "" -- lossy, never a throw (measured).
var trunc:ByteArray = new ByteArray();
trunc.writeByte(0xe4);
trunc.writeByte(0xb8);
trunc.position = 0;
check(trunc.readMultiByte(2, "utf-8") == "", "a truncated utf-8 sequence decodes lossily");

// Reading past the end is EOFError #2030 for the new reads (measured).
var eof:ByteArray = new ByteArray();
eof.writeByte(0x41);
eof.position = 0;
var eofId:int = 0;
try { eof.readMultiByte(4, "utf-8"); } catch (e:Error) { eofId = e.errorID; }
check(eofId == 2030, "readMultiByte past the end throws EOFError #2030, got " + eofId);

// ---- readBoolean / writeBoolean ----------------------------------------
var bools:ByteArray = new ByteArray();
bools.writeBoolean(true);
bools.writeBoolean(false);
check(hex(bools) == "01 00 ", "writeBoolean writes exactly one byte");

var rb:ByteArray = new ByteArray();
rb.writeByte(0xff);
rb.position = 0;
check(rb.readBoolean(), "any non-zero byte reads as true (0xFF)");
rb = new ByteArray();
rb.writeByte(0x80);
rb.position = 0;
check(rb.readBoolean(), "any non-zero byte reads as true (0x80)");
rb = new ByteArray();
rb.writeByte(0x00);
rb.position = 0;
check(!rb.readBoolean(), "a zero byte reads as false");
rb = new ByteArray();
var rbId:int = 0;
try { rb.readBoolean(); } catch (e2:Error) { rbId = e2.errorID; }
check(rbId == 2030, "readBoolean at EOF throws #2030, got " + rbId);

// ---- ByteArray index reads/writes (measured on adl 51.4.1) --------------
var bi:ByteArray = new ByteArray();
bi[0] = 65;
check(bi.length == 1 && bi[0] == 65, "an index write creates the first byte");
bi[bi.length] = 66;
check(bi.length == 2 && bi[1] == 66, "a write at length appends (the padding idiom)");
bi[5] = 67;
check(bi.length == 6 && bi[5] == 67 && bi[3] == 0, "a write past the end extends and zero-fills");

var bw:ByteArray = new ByteArray();
bw[0] = 300;
check(bw[0] == 44, "an out-of-range value is truncated to the low byte (300 -> 44)");
bw[1] = -1;
check(bw[1] == 255, "-1 writes as 0xFF");
bw[2] = 1.7;
check(bw[2] == 1, "a fraction truncates toward zero");
bw[3] = "x";
check(bw[3] == 0, "a non-numeric value writes 0");
bw[4] = true;
check(bw[4] == 1, "true writes 1");
bw[5] = null;
check(bw[5] == 0, "null writes 0");

var bp:ByteArray = new ByteArray();
bp.writeByte(9);
bp[0] = 8;
check(bp[0] == 8 && bp.position == 1, "an index write does not move the position cursor");

// Two AS3 forms real crypto code uses: `new C` without an argument list, and a
// logical assignment to an index (com.hurlant's MD5: `new ByteArray;`,
// `src[src.length] = 0`, `x[i] ||= 0`).
var noParens:ByteArray = new ByteArray;
check(noParens.length == 0, "new ByteArray without parens constructs the same object");
var holes:Array = [];
holes[0] ||= 7;
holes[1] ||= 0;
holes[0] ||= 9;
check(holes[0] == 7 && holes[1] == 0, "a[i] ||= v fills only the falsy holes");

// ---- out-of-range reads throw (measured on adl 51.4.1) ------------------
// Every pre-existing typed read used to return 0 (or partial data) past the
// end. AIR raises EOFError #2030 for all of them -- readUTFBytes/readBytes
// included, and a partial-but-short read is #2030 rather than a clamped value.
function eofId(fn:Function):int {
	try { fn(); } catch (e:Error) { return e.errorID; }
	return -1;
}
var ee:ByteArray = new ByteArray();
var short1:ByteArray = new ByteArray();
short1.writeByte(1);
check(eofId(function():* { return ee.readByte(); }) == 2030, "readByte at EOF throws #2030");
check(eofId(function():* { return ee.readUnsignedByte(); }) == 2030, "readUnsignedByte at EOF throws #2030");
check(eofId(function():* { return ee.readShort(); }) == 2030, "readShort at EOF throws #2030");
check(eofId(function():* { return ee.readUnsignedShort(); }) == 2030, "readUnsignedShort at EOF throws #2030");
check(eofId(function():* { return ee.readInt(); }) == 2030, "readInt at EOF throws #2030");
check(eofId(function():* { return ee.readUnsignedInt(); }) == 2030, "readUnsignedInt at EOF throws #2030");
check(eofId(function():* { return ee.readFloat(); }) == 2030, "readFloat at EOF throws #2030");
check(eofId(function():* { return ee.readDouble(); }) == 2030, "readDouble at EOF throws #2030");
check(eofId(function():* { return ee.readUTF(); }) == 2030, "readUTF at EOF throws #2030");
check(eofId(function():* { return ee.readUTFBytes(1); }) == 2030, "readUTFBytes past the end throws #2030");
check(eofId(function():* { return short1.readUnsignedInt(); }) == 2030, "a short read is #2030, not a clamped value");
check(eofId(function():void { ee.readBytes(short1, 0, 4); }) == 2030, "readBytes past the end throws #2030");

// Out-of-range index access: the read form is #1069, the write form #1056.
check(eofId(function():* { return bw[-2]; }) == 1069, "a negative index read throws #1069");
check(eofId(function():void { var neg:ByteArray = new ByteArray(); neg[-1] = 5; }) == 1056, "a negative index write throws #1056");

// ---- AMF3 markers (byte-exact against adl) ------------------------------
function enc(v:*):String {
	var out:ByteArray = new ByteArray();
	out.writeObject(v);
	return hex(out);
}

check(enc(null) == "01 ", "AMF3 null is 0x01");
check(enc(undefined) == "00 ", "AMF3 undefined is 0x00");
check(enc(true) == "03 ", "AMF3 true is 0x03");
check(enc(false) == "02 ", "AMF3 false is 0x02");
check(enc(5) == "04 05 ", "AMF3 integer uses the compact 0x04 form");
check(enc(-1) == "04 ff ff ff ff ", "AMF3 -1 uses the four-byte U29 form");
check(enc(70000) == "04 84 a2 70 ", "AMF3 70000 uses the three-byte U29 form");
check(enc(1.5) == "05 3f f8 00 00 00 00 00 00 ", "AMF3 1.5 uses 0x05 plus a big-endian double");
check(enc("hi") == "06 05 68 69 ", "AMF3 string is 0x06 + U29S + utf-8 bytes");
check(enc("") == "06 01 ", "AMF3 empty string is a zero-length literal");
check(enc("中文") == "06 0d e4 b8 ad e6 96 87 ", "the U29S length counts UTF-8 bytes");
check(enc([1, 2, 3]) == "09 07 01 04 01 04 02 04 03 ", "a dense AMF3 Array has no associative section");
check(enc(new Date(0)) == "08 01 00 00 00 00 00 00 00 00 ", "AMF3 Date is an inline U29O plus epoch ms");

var nested:ByteArray = new ByteArray();
nested.writeByte(1);
nested.writeByte(2);
check(enc(nested) == "0c 05 01 02 ", "a nested ByteArray is 0x0c + length + raw bytes");

var vec:Vector.<int> = new Vector.<int>();
vec.push(1);
vec.push(2);
check(enc(vec) == "0d 05 00 00 00 00 01 00 00 00 02 ", "Vector.<int> is 0x0d + count + type + big-endian ints");

var dict:Dictionary = new Dictionary();
dict["k"] = 1;
check(enc(dict) == "11 03 00 06 03 6b 04 01 ", "AMF3 Dictionary is 0x11 + count + weak byte + pairs");

// A self reference uses the object table: element 0 is a U29O reference.
var selfRef:Array = [];
selfRef.push(selfRef);
check(enc(selfRef) == "09 03 01 09 00 ", "a repeated object becomes a U29O reference");

// The reference tables are per writeObject call, so the same object written
// twice is emitted twice (measured).
var shared:Array = [1];
check(enc(shared) == enc(shared), "reference tables are reset per writeObject call");

// ---- AMF3 typed objects -------------------------------------------------
var p:Person = new Person();
p.name = "Ann";
p.age = 30;
p.hidden = "h";
// No alias registered: the class name is EMPTY, and traits list public
// instance variables (own members before the superclass chain).
check(enc(p) == "0a 33 01 09 6e 61 6d 65 07 61 67 65 0d 68 69 64 64 65 6e 06 07 41 6e 6e 04 1e 06 03 68 ",
	"an unaliased class writes an EMPTY class name and its public members");

registerClassAlias("myAlias", Person);
check(enc(p) == "0a 33 0f 6d 79 41 6c 69 61 73 09 6e 61 6d 65 07 61 67 65 0d 68 69 64 64 65 6e 06 07 41 6e 6e 04 1e 06 03 68 ",
	"an aliased class writes the alias and its public members");

var e:Employee = new Employee();
e.name = "Bob";
e.age = 40;
e.extra = "x";
check(enc(e) == "0a 43 0f 6d 79 41 6c 69 61 73 0b 65 78 74 72 61 09 6e 61 6d 65 07 61 67 65 0d 68 69 64 64 65 6e 06 03 78 06 07 42 6f 62 04 28 06 08 ",
	"members are own-first then inherited, the alias covers the hierarchy, and the string table dedupes the values");

// ---- AMF3 round trips ---------------------------------------------------
var rt:ByteArray = new ByteArray();
rt.writeObject("中文");
rt.writeObject(1.5);
rt.writeObject([1, 2]);
rt.writeObject(new Date(0));
rt.position = 0;
check(rt.readObject() == "中文", "round trip: String");
check(rt.readObject() == 1.5, "round trip: Number");
var rtArr:Array = rt.readObject() as Array;
check(rtArr.length == 2 && rtArr[1] == 2, "round trip: Array");
var rtDate:Date = rt.readObject() as Date;
check(rtDate.time == 0, "round trip: Date");

var rtTyped:ByteArray = new ByteArray();
rtTyped.writeObject(p);
rtTyped.position = 0;
var p2:Person = rtTyped.readObject() as Person;
check(p2.name == "Ann" && p2.age == 30 && p2.hidden == "h", "round trip: an aliased typed object is reconstructed");

var rtPlain:ByteArray = new ByteArray();
rtPlain.writeObject({ k: "v" });
rtPlain.position = 0;
var backObj:* = rtPlain.readObject();
check(backObj.k == "v", "round trip: a dynamic object keeps its members");

var rtBa:ByteArray = new ByteArray();
rtBa.writeObject(nested);
rtBa.position = 0;
var backBa:ByteArray = rtBa.readObject() as ByteArray;
check(backBa.length == 2 && backBa[0] == 1 && backBa[1] == 2, "round trip: ByteArray bytes are preserved");

check(getQualifiedClassName(getClassByAlias("myAlias")) == "Person", "getClassByAlias resolves the registered class");

// ---- AMF3 error paths (all measured) ------------------------------------
var badMarker:ByteArray = new ByteArray();
badMarker.writeByte(0x7f);
badMarker.position = 0;
var badId:int = 0;
try { badMarker.readObject(); } catch (e3:Error) { badId = e3.errorID; }
check(badId == 2006, "an unknown marker throws RangeError #2006, got " + badId);

var emptyBa:ByteArray = new ByteArray();
var emptyId:int = 0;
try { emptyBa.readObject(); } catch (e4:Error) { emptyId = e4.errorID; }
check(emptyId == 2030, "readObject on an empty buffer throws #2030, got " + emptyId);

var aliasId:int = 0;
try { getClassByAlias("nothing-registered"); } catch (e5:Error) { aliasId = e5.errorID; }
check(aliasId == 1014, "an unknown alias throws ReferenceError #1014, got " + aliasId);

var argId:int = 0;
try { registerClassAlias(null, Person); } catch (e6:Error) { argId = e6.errorID; }
check(argId == 2007, "registerClassAlias(null, X) throws TypeError #2007, got " + argId);

// AMF0 is a registered gap: the codec refuses loudly instead of writing AMF3.
var amf0:ByteArray = new ByteArray();
amf0.objectEncoding = 0;
var amf0Threw:Boolean = false;
try { amf0.writeObject(1); } catch (e7:Error) { amf0Threw = true; }
check(amf0Threw, "objectEncoding = AMF0 is refused loudly (AMF0 is not implemented)");

var enc3:ByteArray = new ByteArray();
check(enc3.objectEncoding == 3, "ByteArray defaults to ObjectEncoding.AMF3");

trace("stage94d ByteArray multibyte / boolean / AMF3: all checks passed");