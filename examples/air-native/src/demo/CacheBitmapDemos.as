package demo {
  import flash.display.Sprite;
  import flash.display.Shape;
  import flash.display.Stage;
  import flash.display.DisplayObject;
  import flash.text.TextField;
  import flash.text.TextFormat;

  /**
   * Stage 67 — flash.display.DisplayObject.cacheAsBitmap.
   * When cacheAsBitmap is true, the container subtree is baked once into an
   * offscreen bitmap and that snapshot is blitted every frame instead of
   * re-walking the children (the adl-style static-subtree optimization).
   * The flag never changes the *visible* result — only the render path — so the
   * visual check draws two identical complex subtrees side by side (one cached,
   * one uncached) and the on-screen output must be pixel-identical.
   */
  public class CacheBitmapDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- cacheAsBitmap (stage 67) ---");

      // Default: false on a fresh DisplayObject.
      var sp:Sprite = new Sprite();
      Assert.check(sp.cacheAsBitmap == false, "cacheAsBitmap default false");
      Assert.check(sp is DisplayObject, "Sprite is DisplayObject");

      // get / set roundtrip through the accessor.
      sp.cacheAsBitmap = true;
      Assert.check(sp.cacheAsBitmap == true, "cacheAsBitmap set -> get roundtrip");

      // Toggle back (setter must invalidate the cached bitmap without error).
      sp.cacheAsBitmap = false;
      Assert.check(sp.cacheAsBitmap == false, "cacheAsBitmap toggle back to false");

      // The flag is inherited by the whole display hierarchy.
      var sh:Shape = new Shape();
      sh.cacheAsBitmap = true;
      Assert.check(sh.cacheAsBitmap == true, "Shape inherits cacheAsBitmap");
      var tf:TextField = new TextField();
      Assert.check(tf.cacheAsBitmap == false, "TextField cacheAsBitmap default false");

      Log.out("CacheBitmapDemos: cacheAsBitmap accessor assertions passed");
    }

    /**
     * Visual check: two identical nested subtrees (nested containers + shapes +
     * a label), one with cacheAsBitmap=true (baked) and one with =false (direct
     * recursive draw). Both must rasterize identically — this is the key
     * invariant of the bitmap-cache optimization.
     */
    public static function visualize(stage:Stage):void {
      var holder:Sprite = new Sprite();
      holder.x = 410;
      holder.y = 20;

      addLabel(holder, "cacheAsBitmap=true", 0);
      var cached:Sprite = buildSubtree(0);
      cached.cacheAsBitmap = true;
      holder.addChild(cached);

      addLabel(holder, "cacheAsBitmap=false", 240);
      var direct:Sprite = buildSubtree(240);
      direct.cacheAsBitmap = false;
      holder.addChild(direct);

      stage.addChild(holder);
    }

    // A small nested subtree: a rounded container with a filled rect, a circle,
    // and a rotated bar — enough depth that baking it is meaningful.
    private static function buildSubtree(x:Number):Sprite {
      var root:Sprite = new Sprite();
      root.x = x;
      root.y = 24;

      var panel:Shape = new Shape();
      panel.graphics.beginFill(0xEEEEEE);
      panel.graphics.drawRect(0, 0, 200, 140);
      panel.graphics.endFill();
      root.addChild(panel);

      var box:Shape = new Shape();
      box.graphics.beginFill(0x3366CC);
      box.graphics.drawRect(16, 16, 120, 90);
      box.graphics.endFill();
      root.addChild(box);

      var circle:Shape = new Shape();
      circle.graphics.beginFill(0xCC6633);
      circle.graphics.drawCircle(156, 46, 36);
      circle.graphics.endFill();
      root.addChild(circle);

      var bar:Shape = new Shape();
      bar.graphics.beginFill(0x33CC66);
      bar.graphics.drawRect(0, 0, 130, 18);
      bar.graphics.endFill();
      bar.x = 30;
      bar.y = 120;
      bar.rotation = -8;
      root.addChild(bar);

      return root;
    }

    private static function addLabel(holder:Sprite, text:String, x:Number):void {
      var t:TextField = new TextField();
      t.defaultTextFormat = new TextFormat("_sans", 10, 0x666666);
      t.text = text;
      t.x = x;
      t.y = 0;
      t.width = 150;
      t.height = 16;
      holder.addChild(t);
    }
  }
}
