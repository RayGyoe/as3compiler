// Stage 4 (v0.3.3): const/static/get/set/final + interface + Object root.

const MAX_SCORE:int = 100;

interface IShape {
  function area():Number;
  function label():String;
}

final class Circle implements IShape {
  const PI:Number = 3.14159;
  static var count:int = 0;
  var _r:Number;

  function Circle(r:Number) {
    _r = r;
    count = count + 1;
  }

  function area():Number { return PI * _r * _r; }
  function label():String { return "circle"; }

  static function total():int { return count; }

  function get radius():Number { return _r; }
  function set radius(v:Number) { _r = v; }
}

// Number defaults to NaN, not 0.
var n:Number;
trace("NaN default:", isNaN(n));       // true

var c:Circle = new Circle(2);
var d:Circle = new Circle(3);
trace(c.area());                        // 12.56636
trace(Circle.count);                    // 2
trace(Circle.total());                  // 2
trace(MAX_SCORE);                       // 100

c.radius = 5;                           // setter
trace(c.radius);                        // 5 (getter)

var s:IShape = c;
trace(s.label(), s.area());             // circle 78.53975

trace(c is IShape);                     // true
trace(c is Circle);                     // true
trace(c.toString());                    // "Circle" (inherited from Object)
