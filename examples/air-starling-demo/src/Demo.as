package
{
    import flash.desktop.NativeApplication;
    import flash.display.Bitmap;
    import flash.display.Loader;
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.events.VsyncStateChangeAvailabilityEvent;
    import flash.filesystem.File;
    import flash.filesystem.FileMode;
    import flash.filesystem.FileStream;
    import flash.geom.Rectangle;
    import flash.system.Capabilities;
    import flash.system.System;
    import flash.utils.ByteArray;
    import flash.utils.setTimeout;

    import starling.assets.AssetManager;
    import starling.core.Starling;
    import starling.events.Event;
    import starling.utils.RectangleUtil;
    import starling.utils.ScaleMode;
    import starling.utils.StringUtil;
    import starling.utils.SystemUtil;

    import utils.ProgressBar;

    //[SWF(width="320", height="480", frameRate="30", backgroundColor="#000000")]
    public class Demo extends Sprite
    {
        private var _starling:Starling;
        private var _background:Loader;
        private var _progressBar:ProgressBar;

        public function Demo()
        {
            // This demo still uses a fixed coordinate sytem of 320x480, just like the original
            // iPhone and iPhone 4/4S. The contents is then centered on the screen. Nowadays,
            // you'd use a different approach, of course. See the "Scaffold" project for a sample.

            stage.frameRate = 60;

            // Adapt the frame rate to the display the window is actually on. AIR has no
            // refresh-rate query, so our runtime reports the panel's rate through
            // VsyncStateChangeAvailabilityEvent.refreshRate (an opt-in extension of the
            // AIR event); it fires once the rate is known and again when the window moves
            // to a display with a different rate. Without this the BenchmarkScene targets
            // 120 fps on a 60 Hz panel, so the ramp never reaches its target and the run
            // hangs (see temp/benchvar/).
            stage.addEventListener(
                    VsyncStateChangeAvailabilityEvent.VSYNC_STATE_CHANGE_AVAILABILITY, onVsyncRefreshRate);

            var screenSize:Rectangle = new Rectangle(0, 0, stage.fullScreenWidth, stage.fullScreenHeight);


            System.output(screenSize.toString());


            var scaleFactor:int = 2;//screenSize.width < 480 ? 1 : 2; // midway between 320 and 640


            Starling.multitouchEnabled = true; // useful on mobile devices

            _starling = new Starling(Game, stage, screenSize);
            _starling.stage.stageWidth    = screenSize.width;  // <- same size on all devices!
            _starling.stage.stageHeight   = screenSize.height; // <- same size on all devices!
            _starling.supportHighResolutions = true;
            //_starling.enableErrorChecking = Capabilities.isDebugger;
            _starling.skipUnchangedFrames = true;
            _starling.simulateMultitouch  = false;
            _starling.addEventListener(starling.events.Event.ROOT_CREATED, function():void
            {
                System.output('\n ROOT_CREATED = start load');


                loadAssets(scaleFactor, startGame);
            });

            _starling.start();
            initElements(scaleFactor);

            // When the game becomes inactive, we pause Starling; otherwise, the enter frame event
            // would report a very long 'passedTime' when the app is reactivated.

            if (!SystemUtil.isDesktop)
            {
                NativeApplication.nativeApplication.addEventListener(
                        flash.events.Event.ACTIVATE, function (e:*):void { _starling.start(); });
                NativeApplication.nativeApplication.addEventListener(
                        flash.events.Event.DEACTIVATE, function (e:*):void { _starling.stop(true); });
            }
        }

        private function onVsyncRefreshRate(e:VsyncStateChangeAvailabilityEvent):void
        {
            // refreshRate is 0 when the backend cannot query the panel (web/offscreen),
            // in which case there is no event at all -- but guard anyway.

            try{
                if (e['refreshRate'])
                    stage.frameRate = e['refreshRate'];
            }catch(e:Error){

            }
        }

        private function loadAssets(scaleFactor:int, onComplete:Function):void
        {
            // Our assets are loaded and managed by the 'AssetManager'. To use that class,
            // we first have to enqueue pointers to all assets we want it to load.

            var appDir:File = File.applicationDirectory;
            var assets:AssetManager = new AssetManager(scaleFactor);

            assets.verbose = true; // Capabilities.isDebugger;
            assets.enqueue(
                    appDir.resolvePath("assets/audio"),
                    appDir.resolvePath(StringUtil.format("assets/fonts/{0}x",    scaleFactor)),
                    appDir.resolvePath(StringUtil.format("assets/textures/{0}x", scaleFactor))
            );

            // Now, while the AssetManager now contains pointers to all the assets, it actually
            // has not loaded them yet. This happens in the "loadQueue" method; and since this
            // will take a while, we'll update the progress bar accordingly.

            assets.loadQueue(onLoadComplete, onLoadError, onLoadProgress);

            function onLoadComplete():void
            {
                System.output('\n onLoadComplete');
                // now would be a good time for a clean-up
                System.pauseForGCIfCollectionImminent(0);
                System.gc();

                onComplete(assets);
            }

            function onLoadError(error:String):void
            {
                trace("Error while loading assets: " + error);
            }

            function onLoadProgress(ratio:Number):void
            {
                _progressBar.ratio = ratio;

                System.output('\n onLoadProgress = '+ratio);

            }
        }

        private function startGame(assets:AssetManager):void
        {
            var game:Game = _starling.root as Game;
            game.start(assets);
            setTimeout(removeElements, 150); // delay to make 100% sure there's no flickering.
        }

        private function initElements(scaleFactor:int):void
        {
            // Add background image. By using "loadBytes", we can avoid any flickering.

            var bgPath:String = StringUtil.format("assets/textures/{0}x/background.jpg", scaleFactor);
            var bgFile:File = File.applicationDirectory.resolvePath(bgPath);
            var bytes:ByteArray = new ByteArray();
            var stream:FileStream = new FileStream();
            stream.open(bgFile, FileMode.READ);
            stream.readBytes(bytes, 0, stream.bytesAvailable);
            stream.close();

            _background = new Loader();
            _background.loadBytes(bytes);
            _background.scaleX = 1.0 / scaleFactor;
            _background.scaleY = 1.0 / scaleFactor;
            _starling.nativeOverlay.addChild(_background);

            _background.contentLoaderInfo.addEventListener(flash.events.Event.COMPLETE,
                function(e:Object):void
                {
                    (_background.content as Bitmap).smoothing = true;
                });

            // While the assets are loaded, we will display a progress bar.

            _progressBar = new ProgressBar(175, 20);
            _starling.nativeOverlay.addChild(_progressBar);
            _progressBar.x = (stage.stageWidth - 175) / 2;
            _progressBar.y =  stage.stageHeight * 0.5;
        }

        private function removeElements():void
        {
            if (_background)
            {
                _starling.nativeOverlay.removeChild(_background);
                _background = null;
            }

            if (_progressBar)
            {
                _starling.nativeOverlay.removeChild(_progressBar);
                _progressBar = null;
            }
        }
    }
}