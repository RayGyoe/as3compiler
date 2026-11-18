package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // stringbuild_air.as — 循环字符串累加（`s += "ab"`）基准（原生 AIR AS3 版）
  public class stringbuild_air extends Sprite {
    public function stringbuild_air() {
      var N:int = 2000;
      var ROUNDS:int = 2000;
      var checksum:int = 0;

      var t0:int = getTimer();
      for (var r:int = 0; r < ROUNDS; r++) {
        var s:String = "";
        for (var i:int = 0; i < N; i++) s += "ab";
        checksum += s.length;
        checksum += s.indexOf("ba");
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("stringbuild_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + checksum + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}