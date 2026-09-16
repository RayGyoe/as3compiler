package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // strings_air.as — 字符串 split/join/indexOf/toUpperCase/lastIndexOf（原生 AIR AS3 版）
  public class strings_air extends Sprite {
    public function strings_air() {
      var text:String = "the quick brown fox jumps over the lazy dog";
      var checksum:int = 0;

      var t0:int = getTimer();
      for (var i:int = 0; i < 300000; i++) {
        var joined:String = text.split(" ").join("-");
        checksum += joined.indexOf("fox");
        checksum += joined.toUpperCase().length;
        checksum += joined.split("quick").join("slow").lastIndexOf("o");
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("strings_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + checksum + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}
