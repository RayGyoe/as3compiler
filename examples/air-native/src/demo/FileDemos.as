package demo {
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.events.EventDispatcher;

  /**
   * Stage 64 — flash.filesystem (POSIX filesystem model).
   * Verifies File existence, FileStream open/close/readUTFBytes/writeUTFBytes
   * roundtrip and directory create/delete. exists/isDirectory are read-only
   * *properties* in real AIR (f.exists, not f.exists()); File paths are built
   * from the writable applicationStorageDirectory. The path-bundle representation
   * (nativePath/url echoing the raw string) is as-aot's simplified model and is
   * covered by examples/stage64.as, so it is omitted here to keep this demo
   * compiling and running under both mxmlc and as-aot.
   */
  public class FileDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Filesystem (stage 64) ---");

      // FileMode constants
      Assert.check(FileMode.READ == "read" && FileMode.WRITE == "write", "FileMode READ/WRITE");
      Assert.check(FileMode.APPEND == "append" && FileMode.UPDATE == "update", "FileMode APPEND/UPDATE");

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

      // File: directory create/delete
      var d:File = File.applicationStorageDirectory.resolvePath("air_native_fs_dir");
      d.createDirectory();
      Assert.check(d.exists && d.isDirectory, "createDirectory makes a directory");
      d.deleteDirectory();
      Assert.check(d.exists == false, "deleteDirectory removes it");

      // cleanup the roundtrip file
      f.deleteFile();
      Assert.check(f.exists == false, "deleteFile removes it");

      Log.out("FileDemos: all flash.filesystem assertions passed");
    }
  }
}
