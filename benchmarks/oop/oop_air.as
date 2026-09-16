package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // oop_air.as — 多态虚方法派发 + 对象字段访问（面向对象核心基准，原生 AIR AS3 版）
  public class oop_air extends Sprite {
    public function oop_air() {
      var shapes:Array = [];
      for (var i:int = 0; i < 64; i++) {
        shapes.push(new Circle((i % 8) + 1, (i % 6) + 1));
        shapes.push(new Square((i % 9) + 1, (i % 7) + 1));
        shapes.push(new Rect((i % 7) + 1, (i % 5) + 1));
      }

      var N:int = 20000000;
      var t0:int = getTimer();
      var sum:int = 0;
      for (var j:int = 0; j < N; j++) {
        var s:Figure = shapes[j % 192];
        sum += s.area();
        if (sum >= 1000000000) { sum -= 1000000000; }
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("oop_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + sum + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}

class Figure {
  public var a:int;
  public var b:int;
  public function Figure(a:int, b:int) { this.a = a; this.b = b; }
  public function area():int { return 0; }
}
class Circle extends Figure {
  public function Circle(a:int, b:int) { super(a, b); }
  override public function area():int { return 3 * a * a + 2 * b; }
}
class Square extends Figure {
  public function Square(a:int, b:int) { super(a, b); }
  override public function area():int { return a * a + b; }
}
class Rect extends Figure {
  public function Rect(a:int, b:int) { super(a, b); }
  override public function area():int { return a * b + a + b; }
}
