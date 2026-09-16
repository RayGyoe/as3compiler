package demo {
  import flash.filters.BitmapFilter;
  import flash.filters.BlurFilter;
  import flash.filters.DropShadowFilter;
  import flash.filters.GlowFilter;
  import flash.filters.BitmapFilterQuality;
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.display.Shape;
  import flash.display.Stage;
  import flash.display.DisplayObjectContainer;
  import flash.display.InteractiveObject;
  import flash.display.DisplayObject;
  import flash.display.SimpleButton;
  import flash.display.Loader;
  import flash.display.LoaderInfo;
  import flash.display.BitmapData;
  import flash.geom.Rectangle;
  import flash.geom.Point;
  import flash.text.TextField;
  import flash.text.TextFormat;

  /**
   * Stages 61 + 62 — flash.filters value bundles and flash.display additions.
   * Filters are reference types (clone returns a new instance); SimpleButton
   * holds four states; LoaderInfo carries bytes metadata and a Loader holds
   * content + contentLoaderInfo. The as-aot-specific headless behaviour
   * (tickMovieClips frame pumping, writable totalFrames, the synchronous
   * Loader.load INIT/COMPLETE simulation, and the deferred DropShadow/Glow
   * applyFilter throw) is covered by examples/stage61.as / stage62.as and is
   * omitted here so this demo compiles and runs under both mxmlc and as-aot.
   */
  public class FilterDisplayDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Filters (stage 61) ---");

      // BlurFilter: defaults + custom + clone
      var bf:BlurFilter = new BlurFilter();
      Assert.check(Assert.near(bf.blurX, 4) && Assert.near(bf.blurY, 4) && bf.quality == 1, "BlurFilter defaults (4,4,1)");
      Assert.check(bf is BlurFilter && bf is BitmapFilter && bf is Object, "BlurFilter is BlurFilter/BitmapFilter/Object");

      var bf2:BlurFilter = new BlurFilter(8, 6, 2);
      Assert.check(Assert.near(bf2.blurX, 8) && Assert.near(bf2.blurY, 6) && bf2.quality == 2, "BlurFilter custom ctor");

      var bc:BlurFilter = bf2.clone() as BlurFilter;
      Assert.check(Assert.near(bc.blurX, 8) && Assert.near(bc.blurY, 6) && bc.quality == 2, "BlurFilter.clone copies fields");
      Assert.check(bc != bf2, "BlurFilter.clone returns a new object");

      // DropShadowFilter: defaults + custom + clone
      var ds:DropShadowFilter = new DropShadowFilter();
      Assert.check(Assert.near(ds.distance, 4) && Assert.near(ds.angle, 45), "DropShadowFilter distance/angle defaults");
      Assert.check(ds.color == 0 && Assert.near(ds.alpha, 1), "DropShadowFilter color/alpha defaults");
      Assert.check(ds.inner == false && ds.knockout == false && ds.hideObject == false, "DropShadowFilter bool defaults false");
      Assert.check(ds is DropShadowFilter && ds is BitmapFilter, "DropShadowFilter is BitmapFilter");

      var ds2:DropShadowFilter = new DropShadowFilter(10, 90, 0xFF0000, 0.5, 8, 8, 2, 3, true, false, true);
      Assert.check(Assert.near(ds2.distance, 10) && ds2.color == 0xFF0000, "DropShadowFilter custom ctor (num)");
      Assert.check(ds2.inner == true && ds2.hideObject == true && ds2.knockout == false, "DropShadowFilter custom ctor (bool)");

      var dc:DropShadowFilter = ds2.clone() as DropShadowFilter;
      Assert.check(Assert.near(dc.distance, 10) && dc.color == 0xFF0000 && dc.inner == true, "DropShadowFilter.clone copies fields");

      // GlowFilter: defaults + custom + clone
      var gf:GlowFilter = new GlowFilter();
      Assert.check(gf.color == 0xFF0000 && Assert.near(gf.alpha, 1), "GlowFilter color/alpha defaults");
      Assert.check(Assert.near(gf.blurX, 6) && Assert.near(gf.strength, 2) && gf.quality == 1, "GlowFilter blur/strength/quality defaults");

      var gc2:GlowFilter = new GlowFilter(0x00FF00, 0.75, 3, 3, 1, 2, true, true);
      var gc:GlowFilter = gc2.clone() as GlowFilter;
      // Real AIR quantizes filter alpha to 8-bit fixed point (floor(alpha*255)/255),
      // so 0.75 reads back as 191/255 == 0.7490196078431373.
      Assert.check(gc.color == 0x00FF00 && Assert.near(gc.alpha, 191.0 / 255.0) && gc.inner == true && gc.knockout == true, "GlowFilter custom ctor + clone");

      // BitmapFilterQuality constants
      Assert.check(BitmapFilterQuality.LOW == 1 && BitmapFilterQuality.MEDIUM == 2 && BitmapFilterQuality.HIGH == 3, "BitmapFilterQuality constants");

      // DisplayObject.filters accessor (faithful Array roundtrip)
      var sp:Sprite = new Sprite();
      var list:Array = [bf2, ds];
      sp.filters = list;
      var got:Array = sp.filters;
      Assert.check(got != null && got.length == 2, "DisplayObject.filters roundtrip length");
      Assert.check(got[0] is BlurFilter && got[1] is DropShadowFilter, "filters elements preserved");
      sp.filters = [];
      Assert.check(sp.filters.length == 0, "filters = [] clears the list");

      // BitmapData.applyFilter (BlurFilter box blur): uniform fill is invariant.
      var src:BitmapData = new BitmapData(16, 16, false, 0x336699);
      var dst:BitmapData = new BitmapData(16, 16, false, 0x000000);
      var blur:BlurFilter = new BlurFilter(4, 4, 2);
      dst.applyFilter(src, new Rectangle(0, 0, 16, 16), new Point(0, 0), blur);
      Assert.check(dst.getPixel(7, 7) == 0x336699, "applyFilter BlurFilter preserves uniform color");

      Log.out("");
      Log.out("--- Display (stage 62) ---");

      // MovieClip: defaults + inheritance
      var mc:MovieClip = new MovieClip();
      Assert.check(mc is MovieClip && mc is Sprite && mc is DisplayObjectContainer, "MovieClip is Sprite/DisplayObjectContainer");
      Assert.check(mc is InteractiveObject && mc is DisplayObject, "MovieClip is InteractiveObject/DisplayObject");
      Assert.check(mc.currentFrame == 0, "currentFrame default 0");
      Assert.check(mc.totalFrames == 1, "totalFrames default 1");

      // SimpleButton: four-state bundle
      var up:Sprite = new Sprite();
      var over:Sprite = new Sprite();
      var down:Sprite = new Sprite();
      var hit:Sprite = new Sprite();
      var btn:SimpleButton = new SimpleButton(up, over, down, hit);
      Assert.check(btn is SimpleButton && btn is InteractiveObject, "SimpleButton is InteractiveObject");
      Assert.check(btn.upState == up && btn.overState == over && btn.downState == down && btn.hitTestState == hit, "SimpleButton four states stored");
      var emptyBtn:SimpleButton = new SimpleButton();
      Assert.check(emptyBtn.upState == null && emptyBtn.hitTestState == null, "SimpleButton default states null");

      // LoaderInfo: not directly instantiable in real AIR (ArgumentError #2012);
      // obtain it via Loader.contentLoaderInfo instead. bytes default to 0.
      // (COMPLETE/INIT/PROGRESS/IO_ERROR constants live on Event/ProgressEvent/
      // IOErrorEvent — see EventsDemos)
      var loader:Loader = new Loader();
      Assert.check(loader is Loader && loader is DisplayObjectContainer, "Loader is DisplayObjectContainer");
      Assert.check(loader.contentLoaderInfo != null && loader.contentLoaderInfo is LoaderInfo, "contentLoaderInfo is LoaderInfo");
      Assert.check(loader.contentLoaderInfo.bytesLoaded == 0 && loader.contentLoaderInfo.bytesTotal == 0, "LoaderInfo bytes default 0");
      Assert.check(loader.content == null, "content starts null");

      Log.out("FilterDisplayDemos: all flash.filters / flash.display assertions passed");
    }

    /**
     * Visual check: draw three filled boxes on the stage, each with a filter
     * applied (Blur / DropShadow / Glow) next to an unfiltered reference. Both
     * adl and as-aot rasterize the filters: as-aot wires DisplayObject.filters
     * into the Skia render backend via image filters, so blur / shadow / glow
     * all show on screen on both paths.
     */
    public static function visualize(stage:Stage):void {
      var holder:Sprite = new Sprite();
      holder.x = 20;
      holder.y = 460;

      addLabel(holder, "reference", 0);
      holder.addChild(makeBox(0x999999, 0));

      addLabel(holder, "BlurFilter(8,8,2)", 140);
      var blur:Shape = makeBox(0xFF3366, 140);
      blur.filters = [new BlurFilter(8, 8, 2)];
      holder.addChild(blur);

      addLabel(holder, "DropShadowFilter", 280);
      var shadow:Shape = makeBox(0x33CC66, 280);
      shadow.filters = [new DropShadowFilter(6, 45, 0x000000, 0.8, 8, 8, 2, 3)];
      holder.addChild(shadow);

      addLabel(holder, "GlowFilter", 420);
      var glow:Shape = makeBox(0x3366FF, 420);
      glow.filters = [new GlowFilter(0x00FFFF, 0.9, 12, 12, 2, 2)];
      holder.addChild(glow);

      stage.addChild(holder);
    }

    private static function makeBox(color:uint, x:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, 100, 100);
      s.graphics.endFill();
      s.x = x;
      s.y = 20;
      return s;
    }

    private static function addLabel(holder:Sprite, text:String, x:Number):void {
      var t:TextField = new TextField();
      t.defaultTextFormat = new TextFormat("_sans", 10, 0x666666);
      t.text = text;
      t.x = x;
      t.y = 0;
      t.width = 130;
      t.height = 16;
      holder.addChild(t);
    }
  }
}
