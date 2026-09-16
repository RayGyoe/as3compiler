// stage21: numeric toString(radix) / valueOf / static constants (v0.3.20).

// --- toString(radix) for int ---
var i:int = 255;
trace(i.toString(16) == "ff");   // true
trace(i.toString(2) == "11111111"); // true
trace(i.toString(36) == "73");   // true (7*36 + 3 = 255)
trace(i.toString() == "255");    // true (default radix 10)

// --- toString(radix) for uint ---
var u:uint = 255;
trace(u.toString(16) == "ff");   // true
trace(u.toString(8) == "377");   // true (255 = 3*64 + 7*8 + 7)

// --- toString for Number (base 10 shortest; other bases truncate to int) ---
var n:Number = 255.9;
trace(n.toString() == "255.9");  // true
trace(n.toString(16) == "ff");   // true (truncated to 255)

// --- valueOf returns the value unchanged ---
var x:Number = 3.14;
trace(x.valueOf() == 3.14);      // true
var y:int = 42;
trace(y.valueOf() == 42);        // true

// --- Number static constants ---
trace(Number.MAX_VALUE > 1e308);        // true
trace(Number.MIN_VALUE > 0);            // true
trace(Number.MIN_VALUE < 1e-300);       // true
trace(isNaN(Number.NaN));               // true
trace(Number.POSITIVE_INFINITY > 1e308); // true
trace(Number.NEGATIVE_INFINITY < -1e308); // true

// --- int / uint static constants ---
trace(int.MAX_VALUE == 2147483647);     // true
trace(int.MIN_VALUE == -2147483647 - 1); // true
trace(uint.MAX_VALUE == 4294967295);    // true
trace(uint.MIN_VALUE == 0);             // true
