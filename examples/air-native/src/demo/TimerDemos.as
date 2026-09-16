package demo {
  import flash.utils.Timer;
  import flash.events.EventDispatcher;

  /**
   * Stage 60 — flash.utils.Timer.
   * Verifies construction defaults, start/stop/reset state transitions and
   * delay/repeatCount validation. Deterministic tick-driven firing
   * (the as-aot headless hook tickTimers) is covered by examples/stage60.as
   * and is intentionally omitted here so this demo compiles and runs under
   * both mxmlc and as-aot.
   */
  public class TimerDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Timer (stage 60) ---");

      // constructor + property defaults
      var t:Timer = new Timer(1, 3);
      Assert.check(t is EventDispatcher && t is Object, "Timer is EventDispatcher/Object");
      Assert.check(t.delay == 1, "delay readback");
      Assert.check(t.repeatCount == 3, "repeatCount readback");
      Assert.check(t.currentCount == 0, "currentCount starts 0");
      Assert.check(t.running == false, "running starts false");

      // infinite default (repeatCount = 0)
      var inf:Timer = new Timer(1);
      Assert.check(inf.repeatCount == 0, "default repeatCount == 0");

      // start/stop/reset state transitions
      var t2:Timer = new Timer(1, 100);
      t2.start();
      Assert.check(t2.running == true, "running true after start");
      t2.stop();
      Assert.check(t2.running == false, "running false after stop");
      t2.reset();
      Assert.check(t2.running == false, "running false after reset");
      Assert.check(t2.currentCount == 0, "currentCount zeroed after reset");

      // delay setter validation (negative / non-finite)
      var threw:Boolean = false;
      try { t2.delay = -5; } catch (e:Error) { threw = true; }
      Assert.check(threw, "delay = -5 throws");
      threw = false;
      try { t2.delay = NaN; } catch (e:Error) { threw = true; }
      Assert.check(threw, "delay = NaN throws");

      // repeatCount setter: real AIR does NOT throw for negative/NaN/non-integer
      // values — the value is simply int-truncated (negative kept as-is).
      threw = false;
      try { t2.repeatCount = -1; } catch (e:Error) { threw = true; }
      Assert.check(!threw, "repeatCount = -1 does not throw");
      Assert.check(t2.repeatCount == -1, "repeatCount = -1 stored as-is");

      t2.repeatCount = NaN;
      Assert.check(t2.repeatCount == 0, "repeatCount = NaN truncates to 0");

      t2.repeatCount = -0.5;
      Assert.check(t2.repeatCount == 0, "repeatCount = -0.5 truncates to 0");

      Log.out("TimerDemos: all flash.utils.Timer assertions passed");
    }
  }
}
