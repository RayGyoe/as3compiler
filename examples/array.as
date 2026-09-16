// Array type: literal, index read/write, length, push/pop, for-in/for-each-in.

var a:Array = [10, 20, 30];
trace("len:", a.length);        // 3
trace("a[1]:", a[1]);           // 20

a[3] = 40;                       // auto-grow
trace("len2:", a.length);       // 4
trace("a[3]:", a[3]);           // 40

var n:int = a.push(50);
trace("after push:", n, a.length);   // 5 5

var last = a.pop();
trace("pop:", last, a.length);  // 50 4

var first = a.shift();
trace("shift:", first, a.length);  // 10 3

var m:int = a.unshift(5);
trace("unshift:", m, a[0]);     // 4 5

trace("join:", a.join("-"));    // 5-20-30-40

trace("indexOf 30:", a.indexOf(30));  // 2

var b:Array = a.slice(1, 3);
trace("slice:", b.join(","));   // 20,30

var c:Array = a.concat([99, 100]);
trace("concat:", c.join(","));  // 5,20,30,40,99,100

var removed:Array = a.splice(1, 2, 77, 88);
trace("removed:", removed.join(","));  // 20,30
trace("after splice:", a.join(","));   // 5,77,88,40

// for-in (indices) and for-each-in (values)
trace("for-in:");
for (var i in a) {
  trace("  idx", i, "=", a[i]);
}
trace("for-each-in:");
for each (var v in a) {
  trace("  val", v);
}

// multidimensional arrays
var grid:Array = [[1, 2], [3, 4]];
trace("grid[1][0]:", grid[1][0]);   // 3

// heterogeneous array + string boxing
var mix:Array = [1, "two", 3.5, true];
trace("mix:", mix.join("|"));       // 1|two|3.5|true
trace("mix[0]+10:", mix[0] + 10);   // 11
