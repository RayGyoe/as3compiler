// Stage 455 (#33): int/uint arithmetic is computed in DOUBLE; AIR wraps only when
// the value lands in an int/uint slot (adl 51.4.1 truth, temp/qcn/adl). The default
// emitted form is double so every Number context (box / compare / divide / Number
// store / String) sees the un-wrapped value; a native unsigned-wrap intCode keeps
// int stores / indices / bitwise at native speed (preserves the stage-451 loops).
function assert(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

var a:int = 2147483647;
var b:int = 1;
// Un-wrapped in Number context (AIR 2147483648, not the C int wrap -2147483648).
assert(a + b == 2147483648, "int+int overflow stays Number");
assert(String(a + b) == "2147483648", "int+int String un-wrapped");
assert(((a + b) is int) == false, "overflow value is not int");
assert(((a + b) is uint) == true, "overflow value fits uint");
var n:Number = a + b;
assert(n == 2147483648, "Number store keeps un-wrapped value");
// An int slot store wraps (ES3 ToInt32) — this is the only place AIR wraps.
var x:int = a + b;
assert(x == -2147483648, "int slot wraps to -2147483648");

var c:int = 2000000000;
var d:int = 2;
assert(c * d == 4000000000, "int*int overflow stays Number");
var y:int = c * d;
assert(y == -294967296, "int slot product wraps");

// -0 survives the double product (a native int product would lose the sign).
var f:int = -1;
var g:int = 0;
assert(1 / (f * g) == -Infinity, "1/(-1*0) == -Infinity (-0 survives)");
assert((f * g) == 0, "-0 == 0");
assert((f * g) is int, "-0 is int (value-domain check)");

// Non-overflow int arithmetic is still int-valued.
var five:int = 5;
assert(five + five == 10, "5+5 == 10");
assert((five + five) is int, "5+5 is int");

// uint overflow.
var u:uint = 4294967295;
var v:uint = 1;
assert(u + v == 4294967296, "uint+uint overflow stays Number");
assert(((u + v) is uint) == false, "4294967296 exceeds uint");
var w:uint = u + v;
assert(w == 0, "uint slot wraps to 0");

// Mixed int/uint promotes to Number.
assert(a + v == 2147483648, "int+uint -> Number");

// Negative overflow.
var nMin:int = -2147483648;
assert(nMin - 1 == -2147483649, "negative overflow stays Number");
assert(nMin * -1 == 2147483648, "INT_MIN*-1 stays Number");

// Nested int chain (a string hash): native int speed, correct wrap each step.
// Cross-checked against an explicit double-accumulate + ToInt32 reference.
var h:int = 0;
for (var k:int = 0; k < 1000; k++) h = (h * 31 + k) | 0;
var h2:int = 0;
var t:Number = 0;
for (k = 0; k < 1000; k++) { t = h2 * 31 + k; h2 = int(t); }
assert(h == h2, "hash chain matches explicit ToInt32 wrap");

// Bitwise ops still wrap to int32 (ES3 ToInt32 — AIR does the same).
assert((2147483648 | 0) == -2147483648, "bitwise ToInt32 wraps");
assert((a << 1) == -2, "left shift wraps");

trace("int-overflow: OK");