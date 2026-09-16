package demo {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.system.System;
  import flash.system.Capabilities;
  import flash.text.TextField;
  import flash.text.TextFormat;
  import flash.text.TextFieldAutoSize;
  import flash.utils.getTimer;
  /**
   * Simplified FPS meter — replaces Mr.doob's Stats, which leaned on APIs this
   * compiler subset does not implement yet (E4X XML literals, StyleSheet,
   * htmlText, Rectangle, setTimeout, startDrag, and BitmapData.scroll/fillRect).
   *
   * Keeps the core behaviour: count ENTER_FRAME events, and once a second write
   * the measured FPS plus flash.system.System memory stats into a small TextField
   * in the top-left corner. totalMemory/privateMemory are shown in MiB so the
   * values are readable; this works under both adl (AIR) and as-aot (native).
   */
  public class Fps extends Sprite {
    private var text:TextField;
    private var frames:uint;
    private var last:int;

    public function Fps() {
      text = new TextField();
      text.width = 360;
      //text.autoSize = TextFieldAutoSize.LEFT;
      text.height = 20;
      text.background = true;
      text.backgroundColor = 0x000033;
      text.defaultTextFormat = new TextFormat("_sans", 11, 0xffff00);
      text.mouseEnabled = false;
      addChild(text);

      frames = 0;
      last = getTimer();

      addEventListener(Event.ADDED_TO_STAGE, init);
    }

    private function init(e:Event):void {
      addEventListener(Event.ENTER_FRAME, update);
    }

    private function update(e:Event):void {
      frames++;
      var now:int = getTimer();
      if (now - last >= 1000) {
        // Memory stats in MiB (1 MiB = 1048576 bytes). int() truncates the
        // Number division so the string concat emits a clean integer.
        text.text = "  FPS:" + frames
          + "  MEM:" + int(System.totalMemory / 1048576) + "MB"
          + "  PRIV:" + int(System.privateMemory / 1048576) + "MB"
          + "  RUNTIME:"+ Capabilities.version + "  ";
        frames = 0;
        last = now;
      }
    }
  }
}
