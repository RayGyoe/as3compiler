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
check(raw.readUnsignedInt() == 0x12345678, "LE raw bytes -> u32, got " + raw.readUnsignedInt());

// a mid-stream endian switch must not disturb position/length or prior bytes
var mix:ByteArray = new ByteArray();
mix.writeUnsignedInt(1);
mix.endian = Endian.LITTLE_ENDIAN;
mix.writeUnsignedInt(1);
check(mix.length == 8, "mixed length, got " + mix.length);
check(bytes(mix, 8) == "0,0,0,1,1,0,0,0", "mixed bytes, got " + bytes(mix, 8));

trace("reg-bytearray-endian: all assertions passed");