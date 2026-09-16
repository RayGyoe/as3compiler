package demo {

  /** Shared assertion helpers for the feature demo test cases (stages 58–64). */
  public class Assert {
    public static function check(cond:Boolean, msg:String):void {
      if (!cond) throw new Error("FAIL: " + msg);
    }

    /** Float tolerance comparison, matching the compiler's stage-58+ test suite. */
    public static function near(a:Number, b:Number):Boolean {
      return Math.abs(a - b) < 0.000001;
    }
  }
}
