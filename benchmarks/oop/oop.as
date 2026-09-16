// oop.as — 多态虚方法派发 + 对象字段访问（面向对象核心基准，as3compiler 版）
class Figure {
  var a:int;
  var b:int;
  function Figure(a:int, b:int) { this.a = a; this.b = b; }
  function area():int { return 0; }
}
class Circle extends Figure {
  function Circle(a:int, b:int) { super(a, b); }
  override function area():int { return 3 * a * a + 2 * b; }
}
class Square extends Figure {
  function Square(a:int, b:int) { super(a, b); }
  override function area():int { return a * a + b; }
}
class Rect extends Figure {
  function Rect(a:int, b:int) { super(a, b); }
  override function area():int { return a * b + a + b; }
}

var shapes:Array = [];
var i:int = 0;
while (i < 64) {
  shapes.push(new Circle((i % 8) + 1, (i % 6) + 1));
  shapes.push(new Square((i % 9) + 1, (i % 7) + 1));
  shapes.push(new Rect((i % 7) + 1, (i % 5) + 1));
  i++;
}

var N:int = 20000000;
var t0:Number = new Date().getTime();
var sum:int = 0;
var j:int = 0;
while (j < N) {
  var s:Figure = shapes[j % 192];
  sum += s.area();
  if (sum >= 1000000000) { sum -= 1000000000; }
  j++;
}
var t1:Number = new Date().getTime();

trace("result=" + sum);
trace("time=" + int(t1 - t0));
