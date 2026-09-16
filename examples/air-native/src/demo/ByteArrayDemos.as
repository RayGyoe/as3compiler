package demo {
  import flash.utils.ByteArray;

  /** Demonstrates the flash.utils.ByteArray class. */
  public class ByteArrayDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- ByteArray ---");

      // Write mixed primitive types.
      var ba:ByteArray = new ByteArray();
      ba.writeByte(0x7F);
      ba.writeShort(0x1234);
      ba.writeInt(0x01020304);
      ba.writeUTFBytes("hello");
      Log.out("length after write: " + ba.length); // 1 + 2 + 4 + 5 = 12

      // Read them back in the same order.
      ba.position = 0;
      Log.out("readByte: " + ba.readByte());                    // 127
      Log.out("readShort hex: " + ba.readShort().toString(16)); // 1234
      Log.out("readInt hex: " + ba.readInt().toString(16));     // 1020304
      Log.out("readUTFBytes: " + ba.readUTFBytes(5));           // hello

      // Float round trip.
      var f:ByteArray = new ByteArray();
      f.writeFloat(1.5);
      f.position = 0;
      Log.out("readFloat: " + f.readFloat());                   // 1.5

      // compress / uncompress.
      var data:ByteArray = new ByteArray();
      var text:String = "compressible text compressible text compressible text";
      data.writeUTFBytes(text);
      data.compress();
      Log.out("compressed length < original: " + (data.length < text.length));
      data.uncompress();
      data.position = 0;
      var round:String = data.readUTFBytes(data.bytesAvailable);
      Log.out("uncompress matches: " + (round == text));

      // clear.
      data.clear();
      Log.out("cleared length: " + data.length);                // 0
    }
  }
}
