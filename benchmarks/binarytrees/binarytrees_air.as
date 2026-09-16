package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // binarytrees_air.as — 递归二叉树分配/遍历（对象分配基准，原生 AIR AS3 版）
  public class binarytrees_air extends Sprite {
    public function binarytrees_air() {
      var maxDepth:int = 14;

      var t0:int = getTimer();
      var stretch:Node = make(maxDepth + 1);
      var s:int = check(stretch);
      var longLived:Node = make(maxDepth);
      var sum:int = 0;
      for (var d:int = 4; d <= maxDepth; d += 2) {
        var n:int = 1 << (maxDepth - d + 4);
        for (var i:int = 0; i < n; i++) {
          var t:Node = make(d);
          sum += check(t);
        }
      }
      var l:int = check(longLived);
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("binarytrees_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + s + "," + sum + "," + l + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }

    private function make(depth:int):Node {
      var n:Node = new Node();
      if (depth == 0) {
        n.left = null;
        n.right = null;
      } else {
        n.left = make(depth - 1);
        n.right = make(depth - 1);
      }
      return n;
    }

    private function check(n:Node):int {
      var total:int = 1;
      if (n.left != null) { total += check(n.left); }
      if (n.right != null) { total += check(n.right); }
      return total;
    }
  }
}

class Node {
  public var left:Node;
  public var right:Node;
}
