class Point2D {
  var x:int = 0;
  var y:int = 0;
  function Point2D(x:int, y:int) {
    this.x = x;
    this.y = y;
  }
  function sum():int {
    return this.x + this.y;
  }
}

var p = new Point2D(3, 4);
trace(p.x);
trace(p.y);
trace(p.sum());

class Counter {
  var total:int = 0;
  function Counter(start:int) {
    this.total = start;
  }
  function inc(n:int):int {
    this.total = this.total + n;
    return this.total;
  }
}

var c = new Counter(10);
trace(c.inc(5));
trace(c.inc(1));
