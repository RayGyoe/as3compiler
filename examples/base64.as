// AIR 51 ByteArray base64 codec (toBase64 / writeBase64 / createFromBase64).
//
// Every expectation below was measured on adl 51.4.1 (temp/b64probe/out.txt):
// toBase64 encodes the WHOLE buffer regardless of position and never moves it;
// writeBase64 appends at position, accepts unpadded final quanta, and rejects
// malformed input with ArgumentError #1508 atomically (nothing written);
// null is TypeError #2007; createFromBase64 leaves position at the end.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function hexOf(b:ByteArray):String {
    var s:String = "";
    for (var i:int = 0; i < b.length; ++i) {
        var v:int = b[i];
        s += (v < 16 ? "0" : "") + v.toString(16);
    }
    return s;
}

// ---- toBase64: RFC 4648 §4 vectors ----
var e:ByteArray = new ByteArray();
check(e.toBase64() == "", "empty toBase64");
e.writeByte(0x66);
check(e.toBase64() == "Zg==", "1-byte padding");
e.writeByte(0x6f);
check(e.toBase64() == "Zm8=", "2-byte padding");
e.writeByte(0x6f);
check(e.toBase64() == "Zm9v", "3-byte no padding");

// ---- toBase64: position is ignored and never moved ----
var p:ByteArray = new ByteArray();
p.writeUTFBytes("foo");
p.position = 1;
check(p.toBase64() == "Zm9v", "pos=1 still encodes whole buffer");
check(p.position == 1, "toBase64 must not move position (mid)");
p.position = 3;
check(p.toBase64() == "Zm9v", "pos=end still encodes whole buffer");
check(p.position == 3, "toBase64 must not move position (end)");

// ---- toBase64: full byte range, no line breaks ----
var all:ByteArray = new ByteArray();
for (var i:int = 0; i < 256; ++i) all.writeByte(i);
var enc:String = all.toBase64();
check(enc.length == 344, "256 bytes -> 344 chars, got " + enc.length);
check(enc.indexOf("\n") < 0 && enc.indexOf("\r") < 0, "no line breaks");
check(enc.indexOf("AAECAwQFBgcICQoL") == 0, "alphabet head");
check(enc.substr(enc.length - 4) == "/w==", "alphabet tail");

// ---- writeBase64: return value / position / append ----
var w:ByteArray = new ByteArray();
check(w.writeBase64("Zm9v") == 3, "writeBase64 returns new bytes");
check(w.length == 3 && w.position == 3, "length/position advance");
check(hexOf(w) == "666f6f", "decoded bytes");
w.writeByte(0x41);
check(w.writeBase64("Zg==") == 1, "append after writeByte");
check(w.length == 5 && w.position == 5 && hexOf(w) == "666f6f4166", "append layout");
check(w.writeBase64("") == 0 && w.length == 5, "empty write is a no-op");

// ---- writeBase64: unpadded final quanta are accepted ----
var u:ByteArray = new ByteArray();
check(u.writeBase64("Zg") == 1 && hexOf(u) == "66", "unpadded 2-char quantum");
var u2:ByteArray = new ByteArray();
check(u2.writeBase64("Zm9vZg") == 4 && hexOf(u2) == "666f6f66", "unpadded 6-char string");

// ---- writeBase64: malformed input -> ArgumentError #1508, atomically ----
var bad:Array = ["Zm9v=", "!!!!", "Zm9v\n", "Zm9v ", "A", "Zg===", "Zm9vZg="];
for (var k:int = 0; k < bad.length; ++k) {
    var wb:ByteArray = new ByteArray();
    wb.writeByte(0x41);
    var caught:Boolean = false;
    try { wb.writeBase64(bad[k]); }
    catch (err:ArgumentError) { caught = true; check(err.errorID == 1508, "bad[" + k + "] errorID 1508, got " + err.errorID); }
    check(caught, "bad[" + k + "] must throw ArgumentError");
    check(wb.length == 1 && wb.position == 1, "bad[" + k + "] must not write anything");
}

// ---- null -> TypeError #2007 ----
var tn:Boolean = false;
try { new ByteArray().writeBase64(null); }
catch (err2:TypeError) { tn = true; check(err2.errorID == 2007, "null writeBase64 #2007"); }
check(tn, "writeBase64(null) must throw TypeError");
var tn2:Boolean = false;
try { ByteArray.createFromBase64(null); }
catch (err3:TypeError) { tn2 = true; check(err3.errorID == 2007, "null createFromBase64 #2007"); }
check(tn2, "createFromBase64(null) must throw TypeError");

// ---- createFromBase64: position left at the end ----
var c:ByteArray = ByteArray.createFromBase64("Zm9v");
check(c.length == 3 && c.position == 3 && hexOf(c) == "666f6f", "createFromBase64 layout");
var c0:ByteArray = ByteArray.createFromBase64("");
check(c0.length == 0 && c0.position == 0, "createFromBase64 empty");
var cn:Boolean = false;
try { ByteArray.createFromBase64("!!!!"); }
catch (err4:ArgumentError) { cn = true; check(err4.errorID == 1508, "createFromBase64 #1508"); }
check(cn, "createFromBase64 malformed must throw");

// ---- full roundtrip ----
var rt:ByteArray = ByteArray.createFromBase64(all.toBase64());
check(rt.length == 256, "roundtrip length");
var same:Boolean = true;
for (var j:int = 0; j < 256; ++j) if (rt[j] != j) same = false;
check(same, "roundtrip bytes");

trace("base64: ALL OK");
