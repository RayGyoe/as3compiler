package demo {
  import flash.net.URLRequest;
  import flash.net.URLLoader;
  import flash.net.URLVariables;
  import flash.events.EventDispatcher;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.ui.Keyboard;
  import flash.ui.Mouse;
  import flash.display.Sprite;
  import flash.display.Stage;
  import flash.text.TextField;
  import flash.text.TextFormat;

  /**
   * Stage 63 — flash.net / flash.ui.
   * URLRequest is a value bundle; URLLoader loads asynchronously; URLVariables
   * is an AS3 `dynamic class` whose undeclared string-keyed properties serialize
   * to a query string. Keyboard is a static key-code table; Mouse is static
   * hide/show plus read-only cursor flags.
   *
   * URLLoader.load() reads the URL asynchronously and dispatches
   * COMPLETE/IO_ERROR on a later frame tick (so listeners registered after
   * load() still fire). The demo exercises the async contract (load returns
   * before the event fires) via a guaranteed-missing URL → IO_ERROR, which is
   * identical on adl (AIR) and as-aot. The successful whole-file data path
   * differs by backend (AIR HTTP/app-storage: vs as-aot raw fopen) and is
   * covered by FileDemos (File/FileStream) + examples/stage63.as.
   */
  public class NetUiDemos {
    // Async state for the URLLoader contract check (set from the deferred listener).
    private static var asyncFired:Boolean;

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

      // URLVariables: dynamic class — undeclared string-keyed properties land in
      // a runtime slot table and toString() serializes them as a query string.
      var vars:URLVariables = new URLVariables();
      vars.user = "alice";
      vars.token = "x1y2z3";
      Assert.check(vars.user == "alice", "URLVariables dynamic string prop");
      Assert.check(vars.token == "x1y2z3", "URLVariables dynamic prop read-back");
      var qs:String = vars.toString();
      Assert.check(qs.indexOf("user=alice") >= 0 && qs.indexOf("token=x1y2z3") >= 0, "URLVariables.toString serializes query string");
      Log.out("URLVariables.toString() = '" + qs + "'");

      // URLVariables parses a source query string into decoded properties.
      var parsed:URLVariables = new URLVariables("a=1&b=hello");
      Assert.check(parsed.a == "1", "URLVariables parses a=1");
      Assert.check(parsed.b == "hello", "URLVariables parses b=hello");

      // URLLoader async contract: load() returns before the completion event
      // fires. A guaranteed-missing path dispatches IO_ERROR on the next tick.
      asyncFired = false;
      var ul:URLLoader = new URLLoader();
      ul.addEventListener(IOErrorEvent.IO_ERROR, onLoadError);
      ul.load(new URLRequest("/nonexistent/air-native-async-test.txt"));
      Assert.check(asyncFired == false, "URLLoader.load is asynchronous (no sync dispatch)");

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

    private static function onLoadError(e:IOErrorEvent):void {
      asyncFired = true;
      Log.out("URLLoader async: IO_ERROR fired (deferred to next tick)");
    }

    /**
     * Visual check: show the URLVariables query string and the deferred
     * URLLoader event on screen. The async status is written by onLoadError;
     * the query string is captured synchronously in run().
     */
    public static function visualize(stage:Stage):void {
      var vars:URLVariables = new URLVariables();
      vars.user = "alice";
      vars.token = "x1y2z3";
      var parsed:URLVariables = new URLVariables("a=1&b=hello");

      var t:TextField = new TextField();
      t.x = 20;
      t.y = 600;
      t.width = 520;
      t.height = 60;
      t.background = true;
      t.backgroundColor = 0x102030;
      t.defaultTextFormat = new TextFormat("_sans", 11, 0xDDEFFF);
      t.text = "flash.net (stage 63)  URLVariables.toString() = '" + vars.toString()
        + "'  parsed a=" + parsed.a + " b=" + parsed.b
        + "  |  URLLoader.load() is async (event deferred)";
      stage.addChild(t);
    }
  }
}
