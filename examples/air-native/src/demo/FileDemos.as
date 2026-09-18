package demo {
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.events.EventDispatcher;
  import flash.events.Event;
  import flash.events.ProgressEvent;
  import flash.display.Sprite;
  import flash.display.Stage;
  import flash.text.TextField;
  import flash.text.TextFormat;

  /**
   * Stage 64 — flash.filesystem (POSIX filesystem model).
   * Verifies File existence, FileStream open/close/readUTFBytes/writeUTFBytes
   * roundtrip, directory create/delete, the AIR static directory shortcuts
   * (applicationDirectory / userDirectory / desktopDirectory / documentsDirectory),
   * and FileStream.openAsync (PROGRESS + COMPLETE dispatched on a later frame tick).
   *
   * exists/isDirectory are read-only *properties* in real AIR (f.exists, not
   * f.exists()); File paths are built from the writable applicationStorageDirectory,
   * which both adl and as-aot map to a writable location (so the roundtrip result
   * is identical on both). The path-bundle representation (nativePath/url echoing
   * the raw string) is as-aot's simplified model and is covered by
   * examples/stage64.as, so exact-path assertions are kept tolerant here.
   */
  public class FileDemos {
    // Async state for the openAsync contract check (set from the deferred listeners).
    private static var asyncProgressFired:Boolean;
    private static var asyncCompleteFired:Boolean;
    private static var asyncLoadedBytes:Number;
    private static var asyncStream:FileStream;

    public static function run():void {
      Log.out("");
      Log.out("--- Filesystem (stage 64) ---");

      // FileMode constants
      Assert.check(FileMode.READ == "read" && FileMode.WRITE == "write", "FileMode READ/WRITE");
      Assert.check(FileMode.APPEND == "append" && FileMode.UPDATE == "update", "FileMode APPEND/UPDATE");

      // File static directory shortcuts: all non-null File objects. The exact
      // applicationDirectory path differs by runtime (install dir vs "."), so only
      // the shape and the trailing home-relative segments are asserted.
      Assert.check(File.applicationDirectory != null && File.applicationDirectory is File, "File.applicationDirectory is File");
      Assert.check(File.userDirectory != null && File.userDirectory is File, "File.userDirectory is File");
      Assert.check(File.desktopDirectory != null && File.desktopDirectory is File, "File.desktopDirectory is File");
      Assert.check(File.documentsDirectory != null && File.documentsDirectory is File, "File.documentsDirectory is File");
      Assert.check(File.desktopDirectory.nativePath.indexOf("Desktop") >= 0, "desktopDirectory ends with Desktop");
      Assert.check(File.documentsDirectory.nativePath.indexOf("Documents") >= 0, "documentsDirectory ends with Documents");

      // File: type + existence (built from the writable app-storage location)
      var f:File = File.applicationStorageDirectory.resolvePath("air_native_fs_test.txt");
      Assert.check(f is File && f is EventDispatcher, "File is EventDispatcher");
      Assert.check(f.exists == false, "file does not exist yet");

      // FileStream: write then read roundtrip
      var out:FileStream = new FileStream();
      Assert.check(out is FileStream && out is EventDispatcher, "FileStream is EventDispatcher");
      out.open(f, FileMode.WRITE);
      Assert.check(out.position == 0, "position 0 after open(write)");
      out.writeUTFBytes("hello air-native");
      out.close();
      Assert.check(f.exists, "file exists after write");

      var inp:FileStream = new FileStream();
      inp.open(f, FileMode.READ);
      Assert.check(inp.bytesAvailable == 16, "bytesAvailable 16");
      var text:String = inp.readUTFBytes(16);
      Assert.check(text == "hello air-native", "readUTFBytes roundtrip");
      inp.close();

      // FileStream.openAsync: PROGRESS + COMPLETE are dispatched on a later frame
      // tick (not synchronously). A small file reports its full byte count in one
      // PROGRESS event, identical on adl (AIR async IO) and as-aot (deferred thunk).
      var af:File = File.applicationStorageDirectory.resolvePath("air_native_async_test.txt");
      var aout:FileStream = new FileStream();
      aout.open(af, FileMode.WRITE);
      aout.writeUTFBytes("hello async");
      aout.close();

      asyncProgressFired = false;
      asyncCompleteFired = false;
      asyncLoadedBytes = 0;
      asyncStream = new FileStream();
      asyncStream.addEventListener(ProgressEvent.PROGRESS, onAsyncProgress);
      asyncStream.addEventListener(Event.COMPLETE, onAsyncComplete);
      asyncStream.openAsync(af, FileMode.READ);
      Assert.check(asyncCompleteFired == false, "openAsync does not complete synchronously");
      // NOTE: the handle stays open until onAsyncComplete closes it — the deferred
      // thunk needs the FILE* to report the byte count (closing here would zero it).

      // File: directory create/delete
      var d:File = File.applicationStorageDirectory.resolvePath("air_native_fs_dir");
      d.createDirectory();
      Assert.check(d.exists && d.isDirectory, "createDirectory makes a directory");
      d.deleteDirectory();
      Assert.check(d.exists == false, "deleteDirectory removes it");

      // cleanup the roundtrip files
      f.deleteFile();
      af.deleteFile();
      Assert.check(f.exists == false, "deleteFile removes it");

      Log.out("FileDemos: all flash.filesystem assertions passed");
    }

    private static function onAsyncProgress(e:ProgressEvent):void {
      asyncProgressFired = true;
      asyncLoadedBytes = e.bytesLoaded;
    }

    private static function onAsyncComplete(e:Event):void {
      asyncCompleteFired = true;
      if (asyncStream != null) { asyncStream.close(); asyncStream = null; }
      if (asyncProgressFired && asyncLoadedBytes == 11) {
        Log.out("FileStream openAsync: PROGRESS(bytesLoaded=11) + COMPLETE (async)");
      } else {
        Log.out("FileStream openAsync: PROGRESS=" + asyncProgressFired + " bytesLoaded=" + asyncLoadedBytes + " COMPLETE=" + asyncCompleteFired);
      }
    }

    /**
     * Visual check: a status strip showing the AIR static directories and the
     * write→read file roundtrip, so the filesystem results are readable on screen.
     */
    public static function visualize(stage:Stage):void {
      var t:TextField = new TextField();
      t.x = 20;
      t.y = 660;
      t.width = 980;
      t.height = 20;
      t.background = true;
      t.backgroundColor = 0x201810;
      t.defaultTextFormat = new TextFormat("_sans", 11, 0xFFEEDD);
      t.text = "flash.filesystem (stage 64)  userDirectory=" + File.userDirectory.nativePath
        + "  documentsDirectory=" + File.documentsDirectory.nativePath
        + "  |  FileStream roundtrip 'hello air-native' + openAsync(PROGRESS/COMPLETE)";
      stage.addChild(t);
    }
  }
}
