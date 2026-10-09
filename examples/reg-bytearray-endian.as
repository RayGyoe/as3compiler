// Stage 89+: ByteArray endianness regression.
//
// The 32-bit primitives have a host-order fast path (one 32-bit store instead of
// four shifted byte stores when the ByteArray's endianness already matches the
// machine). That is only legal if the observable bytes are identical in both
// modes, so this pins the exact byte sequence written and the value read back
// for little-endian, big-endian (the AS3 default) and byte-composed inputs --
// plus a mid-stream endian switch, which must not disturb position or length.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function bytes(b:ByteArray, n:int):String {
    var out:String = "";
    for (var i:int = 0; i < n; ++i) {
        if (i > 0) out += ",";
        out += b[i];
    }
    return out;
}

// little-endian: least significant byte first
var le:ByteArray = new ByteArray();
le.endian = Endian.LITTLE_ENDIAN;
le.writeUnsignedInt(0x01020304);
le.writeFloat(1.5);
le.writeInt(-2);
check(bytes(le, 4) == "4,3,2,1", "LE u32 bytes, got " + bytes(le, 4));
check(bytes(le, 8) == "4,3,2,1,0,0,192,63", "LE float bytes, got " + bytes(le, 8));
check(bytes(le, 12) == "4,3,2,1,0,0,192,63,254,255,255,255", "LE int bytes, got " + bytes(le, 12));
le.position = 0;
check(le.readUnsignedInt() == 0x01020304, "LE read u32");
check(le.readFloat() == 1.5, "LE read float");
check(le.readInt() == -2, "LE read int");

// big-endian: the AS3 default, most significant byte first
var be:ByteArray = new ByteArray();
be.writeUnsignedInt(0x01020304);
be.writeFloat(1.5);
check(bytes(be, 4) == "1,2,3,4", "BE u32 bytes, got " + bytes(be, 4));
check(bytes(be, 8) == "1,2,3,4,63,192,0,0", "BE float bytes, got " + bytes(be, 8));
be.position = 0;
check(be.readUnsignedInt() == 0x01020304, "BE read u32");
check(be.readFloat() == 1.5, "BE read float");

// bytes composed by hand must read back as the matching value
var raw:ByteArray = new ByteArray();
raw.endian = Endian.LITTLE_ENDIAN;
raw.writeByte(0x78); raw.writeByte(0x56); raw.writeByte(0x34); raw.writeByte(0x12);
raw.position = 0;
// Read once into a local: re-reading inside the message would run off the end,
// and AIR throws EOFError #2030 for that (measured on adl 51.4.1) -- the old
// silent 0-on-EOF behaviour is what used to hide this.
var rawU32:uint = raw.readUnsignedInt();
check(rawU32 == 0x12345678, "LE raw bytes -> u32, got " + rawU32);

// a mid-stream endian switch must not disturb position/length or prior bytes
var mix:ByteArray = new ByteArray();
mix.writeUnsignedInt(1);
mix.endian = Endian.LITTLE_ENDIAN;
mix.writeUnsignedInt(1);
check(mix.length == 8, "mixed length, got " + mix.length);
check(bytes(mix, 8) == "0,0,0,1,1,0,0,0", "mixed bytes, got " + bytes(mix, 8));

// A double is the plain IEEE-754 byte sequence in the ByteArray's endianness, so
// it does NOT decompose into "high 32 bits first" -- measured on adl 51.4.1
// (temp/pkg1d/oracle/adl-dbl.txt): little-endian 1.0 is 00 00 00 00 00 00 F0 3F
// (last byte 63), big-endian is 3F F0 00 00 00 00 00 00 (first byte 63).
var dle:ByteArray = new ByteArray();
dle.endian = Endian.LITTLE_ENDIAN;
dle.writeDouble(1.0);
check(bytes(dle, 8) == "0,0,0,0,0,0,240,63", "LE double bytes, got " + bytes(dle, 8));
dle.position = 0;
check(dle.readDouble() == 1, "LE read double");
// ...and a hand-built big-endian buffer reads back as 1.0
dle.length = 0;
dle.endian = Endian.BIG_ENDIAN;
dle.writeByte(0x3F); dle.writeByte(0xF0);
for (var z:int = 0; z < 6; ++z) dle.writeByte(0);
dle.position = 0;
var dman:Number = dle.readDouble();
check(dman == 1, "BE raw double bytes -> 1.0, got " + dman);
dle.length = 0;
dle.writeDouble(-2.5);
check(bytes(dle, 8) == "192,4,0,0,0,0,0,0", "BE double -2.5 bytes, got " + bytes(dle, 8));
dle.position = 0;
check(dle.readDouble() == -2.5, "BE read double -2.5");

trace("reg-bytearray-endian: all assertions passed");