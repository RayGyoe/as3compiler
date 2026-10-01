// stage62.as — flash.display additions (v0.3.63): MovieClip / SimpleButton /
// Loader / LoaderInfo.
//
// MovieClip models a looping frame timeline (currentFrame/totalFrames + play/stop/
// gotoAndPlay/gotoAndStop) driven by the as_mc_* frame pool; headless examples
// pump it with tickMovieClips(). totalFrames is writable here (no symbol timeline).
// SimpleButton is a four-state InteractiveObject bundle. Loader.load(url)
// records the URL on contentLoaderInfo, nulls `content`, dispatches INIT
// synchronously and defers the outcome to the next frame tick: COMPLETE (with a
// Bitmap content) for a URL that can be read, IO_ERROR for one that cannot —
// AIR's LoaderInfo.complete is dispatched "when data has loaded successfully",
// so a failed load never reports COMPLETE. Same async contract as stage 63's
// URLLoader, through the shared async IO job table (as_async_submit).

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

// A URL that cannot be read: air dispatches IO_ERROR, never COMPLETE
// (LoaderInfo.complete = "dispatched when data has loaded successfully").
// stage 89-45: the read now runs as an async job and the outcome is staged, so
// `content` also stays null until the event fires.
var loaderIoError:Boolean = false;
function onLoaderIoError(e:IOErrorEvent):void { loaderIoError = true; }
loader.contentLoaderInfo.addEventListener(LoaderInfo.IO_ERROR, onLoaderIoError);
loader.load(new URLRequest("test.swf"));
check(loader.contentLoaderInfo.url == "test.swf", "load records url");
check(loader.contentLoaderInfo.bytesLoaded == 0 && loader.contentLoaderInfo.bytesTotal == 0, "bytes stay 0 while loading");
check(loader.content == null, "content stays null until the event fires");
check(initFired, "load dispatches INIT synchronously");
check(!completeFired, "load does not dispatch COMPLETE synchronously");
tickTimers();
check(!completeFired, "an unreadable URL never reports COMPLETE");
check(loaderIoError, "an unreadable URL reports IO_ERROR on the next tick");

// A readable URL whose payload is not an image: the read succeeds but the decode
// cannot, and AIR reports that as IOErrorEvent.IO_ERROR (#2124 "Loaded file is an
// unknown type") - never as COMPLETE with an empty Bitmap. Decoding a real image
// needs the Skia backend, which the headless --run build does not link, so this
// is the deterministic outcome in every build; the decoded-content path is
// covered by the Skia-backed demo (examples/air-starling-demo).
var okLoader:Loader = new Loader();
var okComplete:Boolean = false;
var okDecodeError:Boolean = false;
function onOkComplete(e:Event):void { okComplete = true; }
function onOkDecodeError(e:IOErrorEvent):void { okDecodeError = true; }
okLoader.contentLoaderInfo.addEventListener(LoaderInfo.COMPLETE, onOkComplete);
okLoader.contentLoaderInfo.addEventListener(LoaderInfo.IO_ERROR, onOkDecodeError);
okLoader.load(new URLRequest("examples/stage62.as"));
check(okLoader.content == null, "readable URL: content null right after load");
check(!okComplete && !okDecodeError, "readable URL: no terminal event is synchronous");
tickTimers();
check(!okComplete, "a non-image payload never reports COMPLETE");
check(okDecodeError, "a non-image payload reports IO_ERROR on the next tick");
check(okLoader.content == null, "a failed decode leaves content null instead of an empty Bitmap");

trace("stage62: all flash.display additions assertions passed");
