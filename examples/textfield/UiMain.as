// UiMain.as — adl（AIR）侧的 **UI 网格**入口。见 Main.as 的「UI 网格」一节。
//
// 为什么要单独一个类：mxmlc 只能把**无参构造**的类当文档类，而 UI 模式的开关是
// `Main` 的构造参数。AOT 侧不需要这个类（entry-ui.as 直接 `new Main(true)`）。
package {
import flash.display.Sprite;

public class UiMain extends Main {
  public function UiMain() {
    super(true);
  }
}
}
