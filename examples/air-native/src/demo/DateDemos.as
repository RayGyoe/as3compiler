package demo {

  /** Demonstrates the built-in Date class. */
  public class DateDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Date ---");

      // Current time.
      var now:Date = new Date();
      Log.out("now.getTime() > 0: " + (now.getTime() > 0));

      // Construct a specific date: 2024-01-15 10:30:00 (month is 0-based).
      var d:Date = new Date(2024, 0, 15, 10, 30, 0, 0);
      Log.out("year: " + d.getFullYear());       // 2024
      Log.out("month: " + d.getMonth());          // 0
      Log.out("day: " + d.getDate());             // 15
      Log.out("hours: " + d.getHours());          // 10
      Log.out("minutes: " + d.getMinutes());      // 30

      // Epoch-millisecond round trip.
      var ts:Number = d.getTime();
      var d2:Date = new Date(ts);
      Log.out("time roundtrip day: " + d2.getDate());

      // Date.parse and comparison.
      var parsed:Number = Date.parse("2024/01/15");
      Log.out("Date.parse > 0: " + (parsed > 0));
      Log.out("same timestamp: " + (d.getTime() == d2.getTime()));

      // Human-readable formatting.
      Log.out("toDateString: " + d.toDateString());
      Log.out("toUTCString: " + d.toUTCString());
    }
  }
}
