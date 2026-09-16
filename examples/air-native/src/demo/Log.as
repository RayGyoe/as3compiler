package demo {
  import flash.display.Stage;
  import flash.system.System;
  import flash.text.TextField;
  import flash.text.TextFormat;

  /**
   * Log: routes demo output both to the debug console (trace) and to a
   * visible TextField on the stage, so the results can be read on screen.
   */
  public class Log {
    private static var field:TextField;

    public static function init(stage:Stage):void {
      if (field != null) return;
      field = new TextField();
      field.y = 20;
      field.multiline = true;
      field.wordWrap = true;
      field.width = 600;
      field.height = 400;
      field.background = true;
      field.backgroundColor = 0x1E1E1E;
      field.defaultTextFormat = new TextFormat("_typewriter", 12, 0xE6E6E6);
      stage.addChild(field);
    }

    public static function out(s:String):void {
      System.output(s + "\n");
      if (field != null) {
        field.appendText(s + "\n");
        field.scrollV = field.maxScrollV;
      }
    }
  }
}
