// Regression: ByteArray zlib + 32-bit-word packing round trip, mirroring how
// Starling's embedded resources are stored (a zlib stream written back as 32-bit
// words and unpacked with uncompress + readUTF, see starling/text/MiniBitmapFont.as).
// A Z_BUF_ERROR, a byte-order mix-up in readUnsignedInt/writeUnsignedInt, or an
// overflowed uint literal all show up here as an empty/corrupted payload.

var text:String =
    "<font><info face=\"mini\"/><chars><char id=\"65\" x=\"1\" y=\"2\"/></chars></font>";

// 1) plain round trip: compress -> uncompress keeps the payload
var ba:ByteArray = new ByteArray();
ba.writeUTFBytes(text);
var rawLength:int = ba.length;
ba.compress();
trace("compressed smaller:", ba.length < rawLength);
ba.uncompress();
trace("roundtrip ok:", ba.length == rawLength && ba.readUTFBytes(rawLength) == text);

// 2) Starling packing: compressed bytes re-read as 32-bit words and written back
//    with writeUnsignedInt must survive byte-for-byte. The word count covers the
//    whole stream (padded with a zero tail, exactly like the embedded XML_DATA).
var packed:ByteArray = new ByteArray();
packed.writeUTFBytes(text);
packed.compress();
packed.position = packed.length;   // compress() rewinds to 0; append the pad byte
while (packed.length % 4 != 0)
    packed.writeByte(0);
packed.position = 0;
var words:Vector.<uint> = new <uint>[];
while (packed.bytesAvailable >= 4)
    words[words.length] = packed.readUnsignedInt();

var repacked:ByteArray = new ByteArray();
for (var i:int = 0; i < words.length; ++i)
    repacked.writeUnsignedInt(words[i]);
repacked.position = 0;
repacked.uncompress();
repacked.position = 0;
trace("packed roundtrip ok:", repacked.readUTFBytes(rawLength) == text);

// 3) uint literals above 2^31 (Starling's XML_DATA is full of them) must survive a
//    write/read round trip through writeUnsignedInt/readUnsignedInt.
var big:Vector.<uint> = new <uint>[3405691582, 3413039936, 2027613533, 4286853117];
var bw:ByteArray = new ByteArray();
for (var b:int = 0; b < big.length; ++b)
    bw.writeUnsignedInt(big[b]);
bw.position = 0;
var same:Boolean = true;
for (var c:int = 0; c < big.length; ++c)
    if (bw.readUnsignedInt() != big[c])
        same = false;
trace("big uint literals ok:", same);

// 4) writeUTF writes the 16-bit byte length + UTF-8 bytes, so readUTF recovers it
var withPrefix:ByteArray = new ByteArray();
withPrefix.writeUTF(text);
trace("writeUTF length prefix:", withPrefix.length == rawLength + 2);
withPrefix.position = 0;
trace("readUTF ok:", withPrefix.readUTF() == text);

// 5) an uncompressed buffer must be left untouched
var plain:ByteArray = new ByteArray();
plain.writeUTFBytes("plain");
plain.uncompress();
trace("plain untouched:", plain.length == 5);