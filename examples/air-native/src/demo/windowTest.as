package demo {
	import flash.desktop.NativeApplication;
	import flash.display.NativeWindow;
	import flash.display.NativeWindowInitOptions;
	import flash.display.NativeWindowSystemChrome;
	import flash.display.Screen;
	import flash.display.StageAlign;
	import flash.display.StageScaleMode;
	import flash.events.NativeWindowDisplayStateEvent;
	import flash.geom.Point;
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

				// 阶段一百九十：窗口表反向查找面。openedWindows 必须是**同一个**
				// NativeWindow 对象（与 stage.nativeWindow 恒等），因此逐项比一下，
				// 这也是 adl 实测的口径（temp/nwor/adl-oracle.txt）。
				reportSurface();

				initview();
			}

			// 只读一遍、只打日志：这些成员在 adl 51.4.1 上的答案分别是
			// 2 / true / null / true / (bounds 原点 + 非客户区边框)。
			private function reportSurface():void {
				var app:NativeApplication = NativeApplication.nativeApplication;
				var opened:* = app.openedWindows;
				var self:NativeWindow = stage.nativeWindow;
				var containsSelf:Boolean = false;
				for (var i:int = 0; i < opened.length; i++) {
					if (opened[i] == self) containsSelf = true;
				}
				var p:Point = globalToScreen(new Point(0, 0));
				trace("openedWindows=" + opened.length + " containsSelf=" + containsSelf
					+ " menuNull=" + (menu == null)
					+ " orderInFrontOf=" + orderInFrontOf(opened[0])
					+ " globalToScreen=" + p.x + "," + p.y
					+ " displayStateChange=" + NativeWindowDisplayStateEvent.CHANGE);
			}
			private function initview():void{


     			stage.addChild(new TweenDemo());
      stage.addChild(new Fps());
			}
	}
}