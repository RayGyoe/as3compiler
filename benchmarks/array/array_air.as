package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // array_air.as — 数值数组迭代与累加（整数数组基准，原生 AIR AS3 版）
  public class array_air extends Sprite {
    public function array_air() {
      var N:int = 20000000;
      var a:Array = [];
      for (var i:int = 0; i < N; i++) { a.push((i * 31) % 997); }

      var t0:int = getTimer();
      var sum:int = 0;
      for (var j:int = 0; j < N; j++) {
        sum += a[j];
        if (sum >= 1000000000) { sum -= 1000000000; }
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("array_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + sum + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}
