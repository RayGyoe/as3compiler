package demo {
	import flash.display.NativeWindow;
	import flash.display.NativeWindowInitOptions;
	import flash.display.NativeWindowSystemChrome;
	import flash.display.Screen;
	import flash.display.StageAlign;
	import flash.display.StageScaleMode;
	import flash.geom.Rectangle;
	import flash.system.Capabilities;

	public class windowTest  extends NativeWindow 
	{
			public function windowTest()
			{
				var windowOptions:NativeWindowInitOptions = new NativeWindowInitOptions();
				windowOptions.systemChrome = NativeWindowSystemChrome.STANDARD;
				//windowOptions.type = NativeWindowType.NORMAL;
				//windowOptions.renderMode = Config.CurrentAppRenderMode;
				//windowOptions.maximizable = false;
				//windowOptions.resizable = false;
				//windowOptions.minimizable = false;
				
				super(windowOptions);
				
				stage.scaleMode = StageScaleMode.NO_SCALE;
				stage.align = StageAlign.TOP_LEFT;
				
				
				var mainScreen:Screen = Screen.mainScreen;
				var screenBounds:Rectangle = mainScreen.bounds;
				
				
				var rect:Rectangle = new Rectangle();
				rect.width  = 600;
				rect.height  = 410 ;
				
				rect.x = (Capabilities.screenResolutionX  - rect.width )*0.5;
				rect.y = (Capabilities.screenResolutionY - rect.height) * 0.5 ^ 0;
				
				bounds = rect;
				title = "Test Open Widnow";


				this.activate();

				initview();
			}
			private function initview():void{


     			stage.addChild(new TweenDemo());
      stage.addChild(new Fps());
			}
	}
}