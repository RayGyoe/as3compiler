package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // fib_air.as — 递归 Fibonacci（整数基准，原生 AIR AS3 版）
  public class fib_air extends Sprite {
    public function fib_air() {
      var t0:int = getTimer();
      var result:int = fib(40);
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("fib_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + result + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }

    private function fib(n:int):int {
      if (n < 2) { return n; }
      return fib(n - 1) + fib(n - 2);
    }
  }
}
