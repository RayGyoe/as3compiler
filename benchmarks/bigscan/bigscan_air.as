package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // bigscan_air.as — 大 ASCII 文本上的 indexOf / charAt / lastIndexOf（原生 AIR AS3 版）
  public class bigscan_air extends Sprite {
    public function bigscan_air() {
      var line:String = "the quick brown fox jumps over the lazy dog";
      var big:String = "";
      for (var k:int = 0; k < 4000; k++) { big += line + "\n"; }

      var sum:int = 0;
      var t0:int = getTimer();
      for (var i:int = 0; i < 200; i++) {
        var p:int = -1;
        for (var j:int = 0; j < 40; j++) { p = big.indexOf("lazy", p + 1); sum += p; }
        sum += big.charAt(90000).length;
        sum += big.lastIndexOf("fox", 100000);
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("bigscan_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + sum + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}
