// Stage3D Shoot-em-up Tutorial Part 1
// by Christer Kaitila - www.mcfunkypants.com

// GameGUI.as
// A typical simplistic framerate display for benchmarking performance,
// plus a way to track rendering statistics from the entity manager.

package
{
	import flash.events.Event;
	import flash.events.TimerEvent;
	import flash.text.TextField;
	import flash.text.TextFormat;
	import flash.utils.getTimer;
	
	public class GameGUI extends TextField
	{
		public var titleText : String = "";
		public var statsText : String = "";
		public var statsTarget : EntityManager;
		private var frameCount:int = 0;
		private var timer:int;
		private var ms_prev:int;
		private var lastfps : Number = 60;
		
		public function GameGUI(title:String = "", inX:Number=8, inY:Number=8, inCol:int = 0xFFFFFF)
		{
			super();
			titleText = title;
			x = inX;
			y = inY;
			width = 500;
			selectable = false;
			defaultTextFormat = new TextFormat("_sans", 9, 0, true);
			text = "";
			textColor = inCol;
			this.addEventListener(Event.ADDED_TO_STAGE, onAddedHandler);
			
		}
		public function onAddedHandler(e:Event):void {
			stage.addEventListener(Event.ENTER_FRAME, onEnterFrame);
		}
		
		private function onEnterFrame(evt:Event):void
		{
			timer = getTimer();
			
			if( timer - 1000 > ms_prev )
			{
				lastfps = Math.round(frameCount/(timer-ms_prev)*1000);
				ms_prev = timer;
				
				// grab the stats from the entity manager
				if (statsTarget)
				{
					statsText = 
						statsTarget.numCreated + ' created ' +
						statsTarget.numReused + ' reused';
				}
				
				text = titleText + ' - ' + statsText + " - FPS: " + lastfps;
				frameCount = 0;
			}
		
			// count each frame to determine the framerate
			frameCount++;
				
		}
	} // end class
} // end package