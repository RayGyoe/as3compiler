package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // spectralnorm_air.as — 谱范数（Vector.<Number> 密集矩阵-向量乘基准，原生 AIR AS3 版）
  public class spectralnorm_air extends Sprite {
    private const N:int = 1000;

    public function spectralnorm_air() {
      var u:Vector.<Number> = new Vector.<Number>();
      var v:Vector.<Number> = new Vector.<Number>();
      var tmp:Vector.<Number> = new Vector.<Number>();
      for (var k:int = 0; k < N; k++) {
        u.push(1.0);
        v.push(0.0);
        tmp.push(0.0);
      }

      var t0:int = getTimer();
      for (var iter:int = 0; iter < 10; iter++) {
        multiplyAtAv(u, v, tmp);
        multiplyAtAv(v, u, tmp);
      }
      var vBv:Number = 0.0;
      var vv:Number = 0.0;
      for (var i:int = 0; i < N; i++) {
        vBv += u[i] * v[i];
        vv += v[i] * v[i];
      }
      var result:Number = Math.sqrt(vBv / vv);
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("spectralnorm_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + int(Math.floor(result * 1000000.0)) + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }

    private function evalA(i:int, j:int):Number {
      var ij:int = i + j;
      return 1.0 / ((ij * (ij + 1)) / 2 + i + 1);
    }

    private function multiplyAv(v:Vector.<Number>, av:Vector.<Number>):void {
      for (var i:int = 0; i < N; i++) {
        var sum:Number = 0.0;
        for (var j:int = 0; j < N; j++) { sum += evalA(i, j) * v[j]; }
        av[i] = sum;
      }
    }

    private function multiplyAtv(v:Vector.<Number>, atv:Vector.<Number>):void {
      for (var i:int = 0; i < N; i++) {
        var sum:Number = 0.0;
        for (var j:int = 0; j < N; j++) { sum += evalA(j, i) * v[j]; }
        atv[i] = sum;
      }
    }

    private function multiplyAtAv(v:Vector.<Number>, atav:Vector.<Number>, tmp:Vector.<Number>):void {
      multiplyAv(v, tmp);
      multiplyAtv(tmp, atav);
    }
  }
}
