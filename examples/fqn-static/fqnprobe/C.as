// 阶段二百一十七 钉子器材：一个**带包名**的类，用来验证「类引用写全限定名」与「写短名」
// 解析到同一份静态 traits（见 examples/fqn-static/main.as 的断言）。
package fqnprobe {
  public class C {
    public static var field:int = 5;
    public static const K:String = "k";
    public static function get seven():int { return 7; }
    public static function m():String { return "m"; }
    private static var _s:int = 0;
    public static function set s(v:int):void { _s = v * 2; }
    public static function get s():int { return _s; }
  }
}
