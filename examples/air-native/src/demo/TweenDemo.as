package demo {
  import flash.display.Sprite;
  import flash.display.Shape;
  import flash.display.StageAlign;
  import flash.display.StageScaleMode;
  import com.greensock.TweenLite;
  import com.greensock.easing.Quad;
  import com.greensock.easing.Cubic;

  import flash.utils.setTimeout;
  import flash.utils.clearTimeout;
  /**
   * Animation test that imports GreenSock TweenLite and tweens a Shape across
   * the stage. Exists to verify whether the AS3->C toolchain can compile a
   * real third-party tweening library (com.greensock.TweenLite) end to end.
   */
  public class TweenDemo extends Sprite {
    private var box:Shape;

    public function TweenDemo() {
      box = new Shape();
      box.graphics.beginFill(0xff0000);
      box.graphics.drawRect(0, 0, 50, 50);
      box.graphics.endFill();
      box.x = 0;
      box.y = 0;
      addChild(box);

      setTimeout(onDone,10);
    }


    private function onDone():void {
      trace("TweenDemo: tween complete, box.x=" + box.x + ", box.y=" + box.y);

      //Quad.easeOut
      TweenLite.to(box, 2, {x:Math.random() * stage.stageWidth, y:Math.random() *stage.stageHeight, ease:Cubic.easeInOut ,onComplete:this.onDone});
    }
  }
}
