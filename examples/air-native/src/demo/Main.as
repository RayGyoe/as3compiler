package demo {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.display.StageScaleMode;
  import flash.display.StageAlign;

  /**
   * Main entry point of the native AS3 demo project.
   * Orchestrates all feature-area demos and prints results via Log.out(),
   * which shows them both in the debug console and on screen.
   */
  public class Main extends Sprite {
    public function Main() {
      if (stage) {
        start();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, onAddedToStage);
      }
    }

    private function onAddedToStage(e:Event):void {
      removeEventListener(Event.ADDED_TO_STAGE, onAddedToStage);
      start();
    }

    private function start():void {
      stage.align = StageAlign.TOP_LEFT;
      stage.scaleMode = StageScaleMode.NO_SCALE;
      stage.frameRate = 120;
      Log.init(stage);

      Log.out("=== Native AS3 Demo ===");

      DateDemos.run();
      ArrayDemos.run();
      ByteArrayDemos.run();
      JsonDemos.run();

      // Stages 58-64 feature verification (dual mxmlc + as-aot compatible).
      GeometryDemos.run();
      EventsDemos.run();
      TimerDemos.run();
      FilterDisplayDemos.run();
      FilterDisplayDemos.visualize(stage);
      NetUiDemos.run();
      NetUiDemos.visualize(stage);
      FileDemos.run();
      FileDemos.visualize(stage);
      GeometryDemos.visualize(stage);

      stage.addChild(new TweenDemo());

      stage.addChild(new Fps());

      Log.out("=== All demos complete ===");


      trace(stage.stageWidth,stage.stageHeight);
    }
  }
}
