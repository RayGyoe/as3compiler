package demo {

  /** Demonstrates the built-in Array class. */
  public class ArrayDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- Array ---");

      var a:Array = [3, 1, 4, 1, 5, 9, 2, 6];
      Log.out("length: " + a.length);              // 8
      Log.out("join: " + a.join("-"));
      Log.out("indexOf(5): " + a.indexOf(5));      // 4
      Log.out("slice(2,5): " + a.slice(2, 5).join(","));

      var b:Array = a.concat([7, 8]);
      Log.out("concat length: " + b.length);

      a.push(10);
      Log.out("after push length: " + a.length);
      Log.out("pop: " + a.pop());

      // map
      var doubled:Array = [1, 2, 3].map(
        function(x:int, i:int, arr:Array):int { return x * 2; }
      );
      Log.out("map doubled: " + doubled.join(","));

      // filter
      var evens:Array = [1, 2, 3, 4, 5, 6].filter(
        function(x:int, i:int, arr:Array):Boolean { return x % 2 == 0; }
      );
      Log.out("filter evens: " + evens.join(","));

      // numeric sort and reverse
      var nums:Array = [30, 1, 200, 7];
      nums.sort(Array.NUMERIC);
      Log.out("sort numeric: " + nums.join(","));
      nums.reverse();
      Log.out("reverse: " + nums.join(","));
    }
  }
}
