// Stage3D Shoot-em-up Tutorial Part 1
// by Christer Kaitila - www.mcfunkypants.com
// Created for active.tutsplus.com

package 
{

	import flash.display3D.*;
	import flash.display.Sprite;
	import flash.display.StageAlign;
	import flash.display.StageQuality;
	import flash.display.StageScaleMode;
	import flash.events.Event;
	import flash.events.ErrorEvent;
	import flash.geom.Rectangle;
	import flash.utils.getTimer;

	import flash.system.System;
		
	public class Main extends Sprite 
	{
		private var _entities : EntityManager;
		private var _spriteStage : LiteSpriteStage;
		private var _gui : GameGUI;
		private var _width : Number = 1000;
		private var _height : Number = 600;
		public var context3D : Context3D;
		
		// constructor function for our game
		public function Main():void 
		{
			if (stage) init();
			else addEventListener(Event.ADDED_TO_STAGE, init);
		}
		
		// called once flash is ready
		private function init(e:Event = null):void 
		{
			removeEventListener(Event.ADDED_TO_STAGE, init);
			stage.frameRate = 80;
			stage.quality = StageQuality.LOW;
			stage.align = StageAlign.TOP_LEFT;
			stage.scaleMode = StageScaleMode.NO_SCALE;
			stage.addEventListener(Event.RESIZE, onResizeEvent);
			trace("Init Stage3D...");
			_gui = new GameGUI("Simple Stage3D Sprite Demo v1");
			addChild(_gui);
			stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, onContext3DCreate);
			stage.stage3Ds[0].addEventListener(ErrorEvent.ERROR, errorHandler);
			stage.stage3Ds[0].requestContext3D(Context3DRenderMode.AUTO);
			trace("Stage3D requested...");		
		}
				
		// this is called when the 3d card has been set up
		// and is ready for rendering using stage3d
		private function onContext3DCreate(e:Event):void 
		{
			trace("Stage3D context created! Init sprite engine...");
			context3D = stage.stage3Ds[0].context3D;
			initSpriteEngine();
		}
		
		// this can be called when using an old version of flash
		// or if the html does not include wmode=direct
		private function errorHandler(e:ErrorEvent):void 
		{
			trace("Error while setting up Stage3D: "+e.errorID+" - " +e.text);
		}

		protected function onResizeEvent(event:Event) : void
		{
			trace("resize event...");
			
			// Set correct dimensions if we resize
			_width = stage.stageWidth;
			_height = stage.stageHeight;
			
			// Resize Stage3D to continue to fit screen
			var view:Rectangle = new Rectangle(0, 0, _width, _height);
			if ( _spriteStage != null ) {
				_spriteStage.position = view;
			}
			if(_entities != null) {
				_entities.setPosition(view);
			}
		}
		
		private function initSpriteEngine():void 
		{
			// init a gpu sprite system
			var stageRect:Rectangle = new Rectangle(0, 0, _width, _height); 
			_spriteStage = new LiteSpriteStage(stage.stage3Ds[0], context3D, stageRect);
			_spriteStage.configureBackBuffer(_width,_height);
			
			// create a single rendering batch
			// which will draw all sprites in one pass
			var view:Rectangle = new Rectangle(0,0,_width,_height)
			_entities = new EntityManager(stageRect);
			_entities.addEventListener(Event.COMPLETE,loadcomplete);
			
		}
		
		private function loadcomplete(e:Event):void{
			if(_entities.createBatch(context3D))
			{
				_spriteStage.addBatch(_entities._batch);
				// add the first entity right now
				_entities.addEntity();
				
				// tell the gui where to grab statistics from
				_gui.statsTarget = _entities; 
				
				// start the render loop
				stage.addEventListener(Event.ENTER_FRAME,onEnterFrame);
			}else{

				System.output('image error \n ');
			}

		}

		// this function draws the scene every frame
		private function onEnterFrame(e:Event):void 
		{
			try 
			{
				// keep adding more sprites - FOREVER!
				// this is a test of the entity manager's
				// object reuse "pool"
				_entities.addEntity();
				
				// erase the previous frame
				context3D.clear(0, 0, 0, 1);
				
				// move/animate all entities
				_entities.update(getTimer());
				
				// draw all entities
				_spriteStage.render();

				// update the screen
				context3D.present();
			}
			catch (e:Error) 
			{
				// this can happen if the computer goes to sleep and
				// then re-awakens, requiring reinitialization of stage3D
				// (the onContext3DCreate will fire again)
			}
		}
	} // end class
} // end package