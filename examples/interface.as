// interface + implements + is/as.

interface IShape {
  function area():Number;
  function label():String;
}

class Circle implements IShape {
  var r:Number;
  function Circle(r:Number) { this.r = r; }
  function area():Number { return 3.14 * r * r; }
  function label():String { return "circle"; }
}

class Square implements IShape {
  var s:Number;
  function Square(s:Number) { this.s = s; }
  function area():Number { return s * s; }
  function label():String { return "square"; }
}

var sh:IShape = new Circle(2);
trace(sh.label(), sh.area());   // circle 12.56

sh = new Square(3);
trace(sh.label(), sh.area());   // square 9

trace(sh is IShape);            // true

var c:Circle = new Circle(1);
trace(c is IShape);             // true
var asShape:IShape = c as IShape;
trace(asShape.area());          // 3.14

// interface dispatch through a heterogeneous array (runtime vtable lookup).
function totalArea(shapes:Array):Number {
  var s:Number = 0;
  for each (var sh:IShape in shapes) {
    s = s + sh.area();
  }
  return s;
}
var arr:Array = [new Circle(2), new Square(3)];
trace(totalArea(arr));          // 12.56 + 9 = 21.56
