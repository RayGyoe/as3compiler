package demo {
  import flash.net.URLRequest;
  import flash.net.URLLoader;
  import flash.events.EventDispatcher;
  import flash.ui.Keyboard;
  import flash.ui.Mouse;

  /**
   * Stage 63 — flash.net / flash.ui.
   * URLRequest is a value bundle; URLLoader is constructed empty. Keyboard is a
   * static key-code table; Mouse is static hide/show plus read-only cursor
   * flags. The synchronous whole-file URLLoader.load() simulation (as-aot
   * simplification) is covered by examples/stage63.as and is omitted here so
   * this demo compiles and runs under both mxmlc and as-aot.
   */
  public class NetUiDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Net / UI (stage 63) ---");

      // URLRequest: value bundle + defaults
      var req:URLRequest = new URLRequest("data.txt");
      Assert.check(req.url == "data.txt", "URLRequest url stored");
      Assert.check(req.method == "GET", "URLRequest method defaults to GET");
      Assert.check(req.data == null, "URLRequest data defaults to null");
      Assert.check(req.contentType == null, "URLRequest contentType defaults to null");
      req.method = "POST";
      Assert.check(req.method == "POST", "URLRequest method writable");

      // URLLoader: construction + type
      var loader:URLLoader = new URLLoader();
      Assert.check(loader is URLLoader && loader is EventDispatcher, "URLLoader is EventDispatcher");
      Assert.check(loader.data == null, "URLLoader data starts null");

      // Keyboard: static key-code constants
      Assert.check(Keyboard.A == 65 && Keyboard.Z == 90, "Keyboard A/Z key codes");
      Assert.check(Keyboard.NUMBER_0 == 48 && Keyboard.NUMBER_9 == 57, "Keyboard 0/9 key codes");
      Assert.check(Keyboard.SPACE == 32 && Keyboard.ENTER == 13, "Keyboard SPACE/ENTER key codes");
      Assert.check(Keyboard.LEFT == 37 && Keyboard.UP == 38 && Keyboard.RIGHT == 39 && Keyboard.DOWN == 40, "Keyboard arrow key codes");

      // Mouse: static hide/show + cursor flags
      Mouse.hide();
      Mouse.show();
      Assert.check(Mouse.cursor == "auto", "Mouse.cursor default auto");
      Assert.check(Mouse.supportsCursor == true, "Mouse.supportsCursor true");
      Assert.check(Mouse.supportsNativeCursor == true, "Mouse.supportsNativeCursor true");

      Log.out("NetUiDemos: all flash.net / flash.ui assertions passed");
    }
  }
}
