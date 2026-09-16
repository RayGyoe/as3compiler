package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // mandelbrot_air.as — Mandelbrot 集合计数（浮点内层循环基准，原生 AIR AS3 版）
  public class mandelbrot_air extends Sprite {
    public function mandelbrot_air() {
      var size:int = 1500;
      var inside:int = 0;

      var t0:int = getTimer();
      for (var py:int = 0; py < size; py++) {
        var ci:Number = 2.0 * py / size - 1.0;
        for (var px:int = 0; px < size; px++) {
          var cr:Number = 2.0 * px / size - 1.5;
          var zr:Number = 0;
          var zi:Number = 0;
          var k:int = 0;
          while (k < 50 && zr * zr + zi * zi <= 4.0) {
            var t:Number = zr * zr - zi * zi + cr;
            zi = 2.0 * zr * zi + ci;
            zr = t;
            k++;
          }
          if (k == 50) { inside++; }
        }
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("mandelbrot_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + inside + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}
