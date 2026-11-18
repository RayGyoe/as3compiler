package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.text.TextField;
  import flash.text.TextFormat;
  import flash.utils.getTimer;

  // textmetrics_air.as — TextField 派生度量往返（原生 AIR AS3 版）
  public class textmetrics_air extends Sprite {
    public function textmetrics_air() {
      var FIELDS:int = 8;
      var LINES:int = 200;
      var ITERS:int = 20000;

      var a:Array = [];
      for (var i:int = 0; i < LINES; i++) a.push("the quick brown fox jumps over the lazy dog 0123456789");
      var text:String = a.join("\n");

      var fields:Array = [];
      for (var f:int = 0; f < FIELDS; f++) {
        var tf:TextField = new TextField();
        var fmt:TextFormat = new TextFormat();
        fmt.font = "Arial";
        fmt.size = 12;
        fmt.color = 0x000000;
        tf.defaultTextFormat = fmt;
        tf.width = 200;
        tf.height = 300;
        tf.multiline = true;
        tf.wordWrap = false;
        tf.text = text;
        fields.push(tf);
      }

      var probe:TextField = fields[0];
      var diag:String = "metrics nl=" + probe.numLines + " tw=" + int(probe.textWidth) +
        " th=" + int(probe.textHeight) + " msh=" + probe.maxScrollH;

      // 与 AOT 侧同样的预热（见 textmetrics.as）：先排一遍，量的是稳态读。
      var warm:int = 0;
      for (var w:int = 0; w < FIELDS; w++) {
        warm += fields[w].numLines + int(fields[w].textWidth) + int(fields[w].textHeight) + fields[w].maxScrollH;
      }

      var checksum:int = 0;
      var thsum:int = 0;
      var t0:int = getTimer();
      for (var it:int = 0; it < ITERS; it++) {
        for (var k:int = 0; k < FIELDS; k++) {
          var g:TextField = fields[k];
          checksum += g.numLines;
          checksum += int(g.textWidth);
          checksum += g.maxScrollH;
          thsum += int(g.textHeight);
        }
      }
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("textmetrics_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes(diag + "\n");
      fs.writeUTFBytes("thsum=" + thsum + " (textHeight: timed, not checked)\n");
      fs.writeUTFBytes("result=" + checksum + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }
  }
}