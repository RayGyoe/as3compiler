// Regression: integer `%` (and `/`) where C is undefined behaviour but AS3 is
// total.
//
// C's integer `%` is UB on a zero divisor (wasm's `srem`/`urem` trap by spec,
// native raises SIGFPE) and on the overflowing `INT_MIN % -1`; C's integer `/`
// would truncate, whereas AS3's `/` is always Number. Both divisors below come
// from an Array so neither the AOT compiler nor `clang -O2` can constant-fold
// the case away -- with `-O2` folding, the unguarded code printed `5 % z == 5`,
// which is neither AS3's value nor a trap, i.e. silently wrong.
//
// Reference values probed with mxmlc + adl (AIR 51) on the same opaque zero:
//   int  `5 % 0` -> NaN (a Number: AVM2's remainder widens on a zero divisor)
//   uint `5 % 0` -> NaN              `INT_MIN % -1` -> 0
//   `7 % 3` -> 1 and `(7 % 3) is int` -> true (ASC types int % int as int)
//   `var r:int = 5 % 0` -> 0         (an int-typed use coerces the NaN to 0)
//   `5 / 0` -> Infinity, `0 / 0` -> NaN, `INT_MIN / -1` -> 2147483648
// Because ASC types `int % int` as int, the guarded int/uint result is exactly
// AS3's value in every int/uint context (including the zero divisor, where AS3
// itself coerces NaN to 0). The single divergence is a *dynamically* typed use
// of a zero-divisor result: AIR yields NaN, we yield the int 0, since NaN cannot
// be represented in the expression's static C type without turning every
// `i % n` into a double. See as_int_rem/as_uint_rem in src/runtime.ts.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// Opaque zero / one / small constants: array element loads cannot be folded.
var nums:Array = [0, 1];
var zi:int    = int(nums[0]);      // 0
var zu:uint   = uint(nums[0]);     // 0
var zd:Number = Number(nums[0]);   // 0.0
var negOne:int = zi - 1;           // -1

var a:int = zi + 5;                // 5
var b:int = zi - 7;                // -7
var seven:int = zi + 7;            // 7
var three:int = zi + 3;            // 3
var negThree:int = zi - 3;         // -3
var au:uint = zu + 5;              // 5

// ------------------------- 1) int % 0: no trap, and AS3's int-typed value 0
check(a % zi == 0, "5 % 0 is 0 (got " + (a % zi) + ")");
check(b % zi == 0, "-7 % 0 is 0 (got " + (b % zi) + ")");
check(zi % zi == 0, "0 % 0 is 0 (got " + (zi % zi) + ")");
var rInt:int = a % zi;
check(rInt == 0, "int-typed 5 % 0 is 0 (got " + rInt + ")");

// ------------------------- 2) uint % 0
check(au % zu == 0, "uint 5 % 0 is 0 (got " + (au % zu) + ")");
var rUint:uint = au % zu;
check(rUint == 0, "uint-typed 5 % 0 is 0 (got " + rUint + ")");

// ------------------------- 3) INT_MIN % -1 (C signed overflow -> UB)
var mn:int = -2147483647 - 1;
check(mn % negOne == 0, "INT_MIN % -1 is 0 (got " + (mn % negOne) + ")");
check(mn / negOne == 2147483648.0, "INT_MIN / -1 is 2147483648 (got " + (mn / negOne) + ")");

// ------------------------- 4) `/` stays AS3's always-Number operator
check(a / zi > 1e308, "5 / 0 is Infinity (got " + (a / zi) + ")");
check(b / zi < -1e308, "-7 / 0 is -Infinity (got " + (b / zi) + ")");
check((zi / zi) != (zi / zi), "0 / 0 is NaN");
var rDiv:int = a / zi;             // Number -> int coercion: NaN/Infinity -> 0
check(rDiv == 0, "int-typed 5 / 0 is 0 (got " + rDiv + ")");
check(seven / three == 7.0 / 3.0, "int / int is a Number division (got " + (seven / three) + ")");

// ------------------------- 5) Number % 0 is NaN (fmod already matched AS3)
check((zd + 5) % zd != (zd + 5) % zd, "Number 5 % 0 is NaN");
check((seven + 0.5) % (three + 0.5) == 0.5, "Number remainder 7.5 % 3.5 is 0.5");

// ------------------------- 6) the defined integer cases are untouched
check(seven % three == 1, "7 % 3 is 1 (got " + (seven % three) + ")");
check(b % three == -1, "-7 % 3 is -1 (got " + (b % three) + ")");
check(seven % negThree == 1, "7 % -3 is 1 (got " + (seven % negThree) + ")");
check((zi + 17) % three == 2, "17 % 3 is 2 (got " + ((zi + 17) % three) + ")");

// ------------------------- 7) the everyday idioms still work
var words:Array = ["a", "b", "c"];
var out:String = "";
for (var i:int = 0; i < 7; i++) out += words[i % words.length];
check(out == "abcabca", "i % length indexing (got " + out + ")");

function loopSum():int {
    var total:int = 0;
    for (var j:int = 0; j < 100; j++) total += j % 7;
    return total;
}
check(loopSum() == 295, "sum of j % 7 for j<100 (got " + loopSum() + ")");

// `i % n` inside a larger expression, and the divisor as a dynamic read.
var dyn:Array = [0, 3];
check(seven % (int(dyn[1]) + 0) == 1, "dynamic divisor 7 % 3 (got " + (seven % (int(dyn[1]))) + ")");
check(seven % int(dyn[0]) == 0, "dynamic zero divisor (got " + (seven % int(dyn[0])) + ")");

trace("int-rem-zero OK");