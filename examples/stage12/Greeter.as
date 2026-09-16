// stage12 Greeter.as — 定义在 package foo 下的类，供跨文件 import 使用。

package foo {
  public class Greeter {
    public var prefix:String;
    public function Greeter(p:String) { prefix = p; }
    public function greet(name:String):String {
      return prefix + ", " + name + "!";
    }
    // internal: 仅同包（foo）内可见。
    internal function secret():String {
      return "internal";
    }
  }

  // 同包访问 internal 成员的类。
  public class Peer {
    public function reveal(g:Greeter):String {
      return g.secret();
    }
  }
}
