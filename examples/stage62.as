// stage62.as — flash.display additions (v0.3.63): MovieClip / SimpleButton /
// Loader / LoaderInfo.
//
// MovieClip models a looping frame timeline (currentFrame/totalFrames + play/stop/
// gotoAndPlay/gotoAndStop) driven by the as_mc_* frame pool; headless examples
// pump it with tickMovieClips(). totalFrames is writable here (no symbol timeline).
// SimpleButton is a four-state InteractiveObject bundle. Loader.load(url) is a
// synchronous simulation (real async URLLoader is stage 63): it records the URL on
// contentLoaderInfo and dispatches INIT then COMPLETE.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- MovieClip: defaults + inheritance + frame timeline ---
var mc:MovieClip = new MovieClip();
check(mc is MovieClip && mc is Sprite && mc is DisplayObjectContainer, "MovieClip is Sprite/DisplayObjectContainer");
check(mc is InteractiveObject && mc is DisplayObject && mc is EventDispatcher, "MovieClip is InteractiveObject/DisplayObject/EventDispatcher");
check(mc.currentFrame == 0, "currentFrame default 0");
check(mc.totalFrames == 1, "totalFrames default 1");

mc.totalFrames = 3;
check(mc.totalFrames == 3, "totalFrames writable");

mc.play();
tickMovieClips();
check(mc.currentFrame == 1, "play advances 0->1");
tickMovieClips();
check(mc.currentFrame == 2, "advances 1->2");
tickMovieClips();
check(mc.currentFrame == 3, "advances 2->3");
tickMovieClips();
check(mc.currentFrame == 1, "wraps 3->1 (loop)");

mc.stop();
tickMovieClips();
check(mc.currentFrame == 1, "stop halts advance");

mc.gotoAndPlay(2);
check(mc.currentFrame == 2, "gotoAndPlay sets frame 2");
tickMovieClips();
check(mc.currentFrame == 3, "gotoAndPlay then advances");

mc.gotoAndStop(2);
check(mc.currentFrame == 2, "gotoAndStop sets frame 2");
tickMovieClips();
check(mc.currentFrame == 2, "gotoAndStop halts advance");

// --- SimpleButton: four-state bundle ---
var up:Sprite = new Sprite();
var over:Sprite = new Sprite();
var down:Sprite = new Sprite();
var hit:Sprite = new Sprite();
var btn:SimpleButton = new SimpleButton(up, over, down, hit);
check(btn is SimpleButton && btn is InteractiveObject && btn is DisplayObject, "SimpleButton is InteractiveObject/DisplayObject");
check(btn.upState == up, "upState stored");
check(btn.overState == over, "overState stored");
check(btn.downState == down, "downState stored");
check(btn.hitTestState == hit, "hitTestState stored");

var empty:SimpleButton = new SimpleButton();
check(empty.upState == null && empty.hitTestState == null, "SimpleButton default states null");

// --- LoaderInfo: metadata + constants ---
var li:LoaderInfo = new LoaderInfo();
check(li is LoaderInfo && li is EventDispatcher, "LoaderInfo is EventDispatcher");
check(li.bytesLoaded == 0 && li.bytesTotal == 0, "LoaderInfo bytes default 0");
check(LoaderInfo.COMPLETE == "complete" && LoaderInfo.INIT == "init", "LoaderInfo COMPLETE/INIT constants");
check(LoaderInfo.OPEN == "open" && LoaderInfo.UNLOAD == "unload", "LoaderInfo OPEN/UNLOAD constants");
check(LoaderInfo.PROGRESS == "progress" && LoaderInfo.IO_ERROR == "ioError", "LoaderInfo PROGRESS/IO_ERROR constants");

// --- Loader: content + contentLoaderInfo + load() ---
var loader:Loader = new Loader();
check(loader is Loader && loader is DisplayObjectContainer, "Loader is DisplayObjectContainer");
check(loader.contentLoaderInfo != null, "contentLoaderInfo non-null at construction");
check(loader.contentLoaderInfo is LoaderInfo, "contentLoaderInfo is LoaderInfo");
check(loader.content == null, "content starts null");

var initFired:Boolean = false;
var completeFired:Boolean = false;
function onLoaderInit(e:Event):void { initFired = true; }
function onLoaderComplete(e:Event):void { completeFired = true; }
loader.contentLoaderInfo.addEventListener(LoaderInfo.INIT, onLoaderInit);
loader.contentLoaderInfo.addEventListener(LoaderInfo.COMPLETE, onLoaderComplete);
loader.load("test.swf");
check(loader.contentLoaderInfo.url == "test.swf", "load records url");
check(initFired, "load dispatches INIT");
check(completeFired, "load dispatches COMPLETE");

trace("stage62: all flash.display additions assertions passed");
