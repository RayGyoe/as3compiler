// Standard library: String methods, Math, global functions, type conversion.

var s:String = "Hello, World";
trace(s.length);              // 12
trace(s.charAt(1));           // e
trace(s.charCodeAt(1));       // 101
trace(s.indexOf("World"));    // 7
trace(s.lastIndexOf("o"));    // 8
trace(s.substring(0, 5));     // Hello
trace(s.substr(7, 5));        // World
trace(s.slice(-5));           // World
trace(s.toUpperCase());       // HELLO, WORLD
trace(s.toLowerCase());       // hello, world

var parts:Array = "a,b,c".split(",");
trace(parts.join("|"));       // a|b|c

trace(Math.PI);               // 3.14159
trace(Math.abs(-5));          // 5
trace(Math.floor(3.7));       // 3
trace(Math.ceil(3.2));        // 4
trace(Math.round(3.5));       // 4
trace(Math.sqrt(16));         // 4
trace(Math.pow(2, 10));       // 1024
trace(Math.min(3, 7));        // 3
trace(Math.max(3, 7));        // 7

trace(parseInt("42"));        // 42
trace(parseFloat("3.14"));    // 3.14
trace(isNaN(0 / 0));          // true
trace(isFinite(10));          // true

trace(String(123));           // 123
trace(Number("3.5"));         // 3.5
trace(int("42"));             // 42
trace(Boolean(""));           // false
trace(Boolean("x"));          // true

class Point2D {
  var x:int;
  var y:int;
  function Point2D(a:int, b:int) { x = a; y = b; }
}
var p:Point2D = new Point2D(1, 2);
trace(p);                     // Point2D
