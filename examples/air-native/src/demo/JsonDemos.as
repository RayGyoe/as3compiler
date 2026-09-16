package demo {

  /** Demonstrates the top-level JSON class. */
  public class JsonDemos {
    public static function run():void {
      Log.out("");
      Log.out("--- JSON ---");

      // Object -> JSON string.
      var obj:Object = { name: "Alice", age: 30, tags: ["as3", "air"], active: true };
      var s:String = JSON.stringify(obj);
      Log.out("stringify: " + s);

      // JSON string -> Object.
      var parsed:Object = JSON.parse(s);
      Log.out("parsed.name: " + parsed.name);
      Log.out("parsed.age: " + parsed.age);
      Log.out("parsed.tags.length: " + parsed.tags.length);
      Log.out("parsed.active: " + parsed.active);

      // Array round trip.
      var arrJson:String = JSON.stringify([1, 2, 3]);
      var arrBack:Array = JSON.parse(arrJson) as Array;
      Log.out("array roundtrip length: " + arrBack.length);

      // Nested object round trip.
      var nested:Object = { user: { id: 7, roles: ["admin", "editor"] } };
      var nestedBack:Object = JSON.parse(JSON.stringify(nested));
      Log.out("nested roles: " + nestedBack.user.roles.join(","));
    }
  }
}
