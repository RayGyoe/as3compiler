// 阶段二百一十七 钉子器材：静态**字段**持有一个函数值（`D.getTime()` 的调用形态），
// 全限定名写法同样要解析到同一个静态槽、并从字段值上分派调用。
package fqnprobe {
  public class D {
    public static var getTime:Function = myTimer;
    public static function myTimer():int { return 42; }
  }
}
