// #86 (stage 452): an opaque BitmapData (transparent=false) forces alpha 0xFF on
// WRITE. AIR measured on adl 51.4.1: setPixels of 0x80FF0000 reads back 0xFFFF0000
// and draws opaque onto a transparent target. setPixels/setVector used to keep the
// source alpha; now every raw-upload path forces 0xFF like setPixel32/fillRect.
// A transparent bitmap keeps its alpha. Any mismatch throws (non-zero exit).
function expect(actual:uint, expected:uint, label:String):void {
  if (actual != expected) {
    throw new Error(label + ": got 0x" + actual.toString(16) + " want 0x" + expected.toString(16));
  }
  trace("ok " + label + " = 0x" + actual.toString(16));
}

// LE setPixels into an opaque bitmap: alpha forced to FF.
var bd:BitmapData = new BitmapData(2, 2, false, 0x00000000);
var ba:ByteArray = new ByteArray();
ba.endian = "littleEndian";
ba.writeByte(0x00); ba.writeByte(0x00); ba.writeByte(0xFF); ba.writeByte(0x80);
ba.position = 0;
bd.setPixels(new Rectangle(0, 0, 1, 1), ba);
expect(bd.getPixel32(0, 0), 0xFFFF0000, "opaque setPixels LE");

// The stored pixel is genuinely opaque: drawing it onto a transparent target
// yields alpha FF (write-side forcing, not a read mask).
var td:BitmapData = new BitmapData(2, 2, true, 0x00000000);
td.draw(bd);
expect(td.getPixel32(0, 0) >>> 24, 0xFF, "opaque draw alpha");

// BE setPixels into an opaque bitmap.
var bb:BitmapData = new BitmapData(2, 2, false, 0);
var be:ByteArray = new ByteArray();
be.endian = "bigEndian";
be.writeByte(0x80); be.writeByte(0x00); be.writeByte(0x00); be.writeByte(0xFF);
be.position = 0;
bb.setPixels(new Rectangle(0, 0, 1, 1), be);
expect(bb.getPixel32(0, 0), 0xFF0000FF, "opaque setPixels BE");

// setVector into an opaque bitmap.
var bv:BitmapData = new BitmapData(2, 2, false, 0);
var vv:Vector.<uint> = new Vector.<uint>();
vv.push(0x800000FF);
bv.setVector(new Rectangle(0, 0, 1, 1), vv);
expect(bv.getPixel32(0, 0), 0xFF0000FF, "opaque setVector");

// setPixel32 into an opaque bitmap (already forced before this stage).
bd.setPixel32(1, 1, 0x8000FF00);
expect(bd.getPixel32(1, 1), 0xFF00FF00, "opaque setPixel32");

// A TRANSPARENT bitmap keeps the source alpha untouched.
var tb:BitmapData = new BitmapData(2, 2, true, 0);
var ta:ByteArray = new ByteArray();
ta.endian = "littleEndian";
ta.writeByte(0x00); ta.writeByte(0x00); ta.writeByte(0xFF); ta.writeByte(0x80);
ta.position = 0;
tb.setPixels(new Rectangle(0, 0, 1, 1), ta);
expect(tb.getPixel32(0, 0), 0x80FF0000, "transparent keeps alpha");

trace("ALL OK");