package demo {
  import flash.events.Event;
  import flash.events.TimerEvent;
  import flash.events.ProgressEvent;
  import flash.events.ErrorEvent;
  import flash.events.IOErrorEvent;
  import flash.events.DataEvent;

  /**
   * Stage 59 — flash.events event subclasses + Event constants.
   * These are pure constant/field bundles (TimerEvent / ProgressEvent /
   * IOErrorEvent / ErrorEvent / DataEvent) layered on the existing Event /
   * EventDispatcher core. No dispatch required here; only construction,
   * constant values and `is` type checks are asserted.
   */
  public class EventsDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Events (stage 59) ---");

      // Event complete constants added in stage 59.
      Assert.check(Event.INIT == "init", "Event.INIT");
      Assert.check(Event.OPEN == "open", "Event.OPEN");
      Assert.check(Event.CLOSE == "close", "Event.CLOSE");
      Assert.check(Event.SELECT == "select", "Event.SELECT");
      Assert.check(Event.CANCEL == "cancel", "Event.CANCEL");
      Assert.check(Event.RENDER == "render", "Event.RENDER");
      Assert.check(Event.UNLOAD == "unload", "Event.UNLOAD");
      Assert.check(Event.SOUND_COMPLETE == "soundComplete", "Event.SOUND_COMPLETE");
      Assert.check(Event.COMPLETE == "complete" && Event.CHANGE == "change" && Event.RESIZE == "resize", "Event COMPLETE/CHANGE/RESIZE");

      // --- TimerEvent ---
      Assert.check(TimerEvent.TIMER == "timer", "TimerEvent.TIMER");
      Assert.check(TimerEvent.TIMER_COMPLETE == "timerComplete", "TimerEvent.TIMER_COMPLETE");
      var te:TimerEvent = new TimerEvent(TimerEvent.TIMER);
      Assert.check(te.type == "timer", "TimerEvent type");
      Assert.check(te.bubbles == false && te.cancelable == false, "TimerEvent defaults false");
      Assert.check(te is Event, "TimerEvent is Event");

      // --- ProgressEvent ---
      Assert.check(ProgressEvent.PROGRESS == "progress", "ProgressEvent.PROGRESS");
      var pe:ProgressEvent = new ProgressEvent(ProgressEvent.PROGRESS, false, false, 100, 1000);
      Assert.check(pe.bytesLoaded == 100 && pe.bytesTotal == 1000, "ProgressEvent bytesLoaded/bytesTotal");
      Assert.check(pe is Event, "ProgressEvent is Event");

      // --- ErrorEvent / IOErrorEvent ---
      Assert.check(ErrorEvent.ERROR == "error", "ErrorEvent.ERROR");
      var ee:ErrorEvent = new ErrorEvent(ErrorEvent.ERROR, false, false, "boom");
      Assert.check(ee.text == "boom", "ErrorEvent.text");
      Assert.check(ee is Event, "ErrorEvent is Event");
      Assert.check(IOErrorEvent.IO_ERROR == "ioError", "IOErrorEvent.IO_ERROR");
      var ie:IOErrorEvent = new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, "net fail");
      Assert.check(ie.text == "net fail", "IOErrorEvent.text (inherited)");
      Assert.check(ie is ErrorEvent && ie is Event, "IOErrorEvent is ErrorEvent/Event");

      // --- DataEvent ---
      Assert.check(DataEvent.DATA == "data", "DataEvent.DATA");
      var de:DataEvent = new DataEvent(DataEvent.DATA, false, false, "payload");
      Assert.check(de.data == "payload", "DataEvent.data");
      Assert.check(de is Event, "DataEvent is Event");

      Log.out("EventsDemos: all flash.events assertions passed");
    }
  }
}
