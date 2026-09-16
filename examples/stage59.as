// stage59.as — flash.events event subclasses + Event constants (v0.3.60):
// TimerEvent / ProgressEvent / IOErrorEvent / ErrorEvent / DataEvent.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- Event complete constants (stage 59 additions) ---
check(Event.INIT == "init", "Event.INIT");
check(Event.OPEN == "open", "Event.OPEN");
check(Event.CLOSE == "close", "Event.CLOSE");
check(Event.SELECT == "select", "Event.SELECT");
check(Event.CANCEL == "cancel", "Event.CANCEL");
check(Event.CLEAR == "clear", "Event.CLEAR");
check(Event.RENDER == "render", "Event.RENDER");
check(Event.SCROLL == "scroll", "Event.SCROLL");
check(Event.TAB_CHILDREN_CHANGE == "tabChildrenChange", "Event.TAB_CHILDREN_CHANGE");
check(Event.TAB_ENABLED_CHANGE == "tabEnabledChange", "Event.TAB_ENABLED_CHANGE");
check(Event.TAB_INDEX_CHANGE == "tabIndexChange", "Event.TAB_INDEX_CHANGE");
check(Event.UNLOAD == "unload", "Event.UNLOAD");
check(Event.SOUND_COMPLETE == "soundComplete", "Event.SOUND_COMPLETE");
// pre-existing constants still intact
check(Event.COMPLETE == "complete" && Event.CHANGE == "change" && Event.RESIZE == "resize", "Event COMPLETE/CHANGE/RESIZE");

// --- TimerEvent ---
check(TimerEvent.TIMER == "timer", "TimerEvent.TIMER");
check(TimerEvent.TIMER_COMPLETE == "timerComplete", "TimerEvent.TIMER_COMPLETE");
var te:TimerEvent = new TimerEvent(TimerEvent.TIMER);
check(te.type == "timer", "TimerEvent type");
check(te.bubbles == false && te.cancelable == false, "TimerEvent defaults false");
check(te is Event, "TimerEvent is Event");

// --- ProgressEvent ---
check(ProgressEvent.PROGRESS == "progress", "ProgressEvent.PROGRESS");
var pe:ProgressEvent = new ProgressEvent(ProgressEvent.PROGRESS, false, false, 100, 1000);
check(pe.bytesLoaded == 100 && pe.bytesTotal == 1000, "ProgressEvent bytesLoaded/bytesTotal");
check(pe is Event, "ProgressEvent is Event");

// --- ErrorEvent / IOErrorEvent ---
check(ErrorEvent.ERROR == "error", "ErrorEvent.ERROR");
var ee:ErrorEvent = new ErrorEvent(ErrorEvent.ERROR, false, false, "boom");
check(ee.text == "boom", "ErrorEvent.text");
check(ee is Event, "ErrorEvent is Event");
check(IOErrorEvent.IO_ERROR == "ioError", "IOErrorEvent.IO_ERROR");
var ie:IOErrorEvent = new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, "net fail");
check(ie.text == "net fail", "IOErrorEvent.text (inherited)");
check(ie is ErrorEvent && ie is Event, "IOErrorEvent is ErrorEvent/Event");

// --- DataEvent ---
check(DataEvent.DATA == "data", "DataEvent.DATA");
var de:DataEvent = new DataEvent(DataEvent.DATA, false, false, "payload");
check(de.data == "payload", "DataEvent.data");
check(de is Event, "DataEvent is Event");

trace("stage59: all flash.events assertions passed");
