package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // cjkscan_air.as — 大 CJK 文本上的 indexOf / lastIndexOf / charCodeAt / substring（原生 AIR 版）
  // AIR 的字符串内部就是 UTF-16，索引直接可用，不需要码元 ↔ 字节翻译。
  public class cjkscan_air extends Sprite {
    public function cjkscan_air() {
      var line:String = "敏捷的棕色狐狸跳过了那只懒狗用它来测试中日韩文字的码元索引和字节偏移之间的翻译开销六字";
      var big:String = "";
      for (var k:int = 0; k < 4000; k++) { big += line + "\n"; }

      var sum:int = 0;
      var t0:int = getTimer();
      for (var i:int = 0; i < 100; i++) {
        var p:int = -1;
        for (var j:int = 0; j < 40; j++) { p = big.indexOf("懒狗", p + 1); sum += p; }
      }
      for (var b:int = 0; b < 100; b++) {
        for (var j2:int = 0; j2 < 40; j2++) { sum += big.lastIndexOf("狐狸", 120000 - j2); }
      }
      for (var q:int = 0; q < 20000; q++) { sum += big.charCodeAt((q * 5003) % 170000); }
      for (var r:int = 0; r < 20000; r++) {
        var o:int = (r * 7919) % 170000;
        sum += big.substring(o, o + 20).length;
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("cjkscan_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + sum + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}
