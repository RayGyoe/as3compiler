package demo {
  import flash.display.Sprite;
  import flash.display.Shape;
  import flash.desktop.NativeApplication;
  import flash.events.Event;
  import flash.system.System;

  // transparent-gpu（阶段四百五十八）：<transparent>true</transparent> 配
  // <renderMode>direct</renderMode> 的 GPU 透明窗。画两条竖带，右三分之一**故意不画**：
  //   左   0..99    不透明红
  //   中   100..199 50% 蓝
  //   右   200..299 未画 —— 透明窗这里必须让桌面透过来（alpha 0）
  //
  // 判定不在 AS3 里：合成后的 alpha 只有窗口抓图能看到（BitmapData.draw 读的是显示列表，
  // 不是窗口服务器的合成结果）。抓图口径与实测数字见 README.md 与
  // docs/zh-cn/skia.md §6.8。本例在回归里只做**编译 + 链接**（GPU 窗口不能无头跑）。
  public class Main extends Sprite {
    private var n:int = 0;
    private var dot:Shape;

    public function Main() {
      if (stage) start(); else addEventListener(Event.ADDED_TO_STAGE, onAdded);
    }

    private function onAdded(e:Event):void {
      removeEventListener(Event.ADDED_TO_STAGE, onAdded);
      start();
    }

    private function start():void {
      var s:Shape = new Shape();
      s.graphics.beginFill(0xFF0000, 1.0); s.graphics.drawRect(0, 0, 100, 200); s.graphics.endFill();
      s.graphics.beginFill(0x0000FF, 0.5); s.graphics.drawRect(100, 0, 100, 200); s.graphics.endFill();
      addChild(s);
      // 一个 1x1 的点每帧翻可见性：静态显示列表不会重绘，抓图会停在第一帧。
      dot = new Shape();
      dot.graphics.beginFill(0x00FF00, 1.0); dot.graphics.drawRect(0, 0, 1, 1); dot.graphics.endFill();
      dot.x = 99; dot.y = 199;
      addChild(dot);
      addEventListener(Event.ENTER_FRAME, onFrame);
    }

    private function onFrame(e:Event):void {
      dot.visible = (n % 2 == 0);
      n++;
      if (n == 20) {
        var w:* = NativeApplication.nativeApplication.activeWindow;
        trace("transparent-gpu: transparent=" + (w == null ? "?" : w.transparent)
          + " stage=" + stage.stageWidth + "x" + stage.stageHeight);
      }
      // 手工抓图留 10 秒窗口（60 fps 约 600 帧），随后干净退出。
      if (n == 600) { trace("transparent-gpu: done"); System.exit(0); }
    }
  }
}