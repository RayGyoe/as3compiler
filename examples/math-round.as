// math-round.as — 阶段三百三十四：`Math.round` 是 floor(x + 0.5)，不是 C 的 round()。
//
// C 的 round() 把 .5 向远离零的方向取整，AS3（ES3）不是：adl 51.4.1 实测
// （temp/qcn/Main8.as，输出 ~/Documents/qcn-out8.txt）——
//   round(-0.4) = +0   round(-0.5) = +0   round(-0.6) = -1
//   round(-1.5) = -1   round(-2.5) = -2   round(2.5) = 3
//   round(0.49999999999999994) = 1   （因为 x+0.5 在 double 里先舍入成 1.0）
//   round(2^52+1) = 4503599627370498   round(1e20) = 1e20
// 旧的 `round(x)` 在 -0.5 给 -1、在 -2.5 给 -3、在 0.49999999999999994 给 0，三处都错。
// 负零也随口径变化：round(-0.4) 与 round(-0.0) 在 AIR 都是 **+0**（1/r 为 +Infinity）。
function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

check(Math.round(-0.4) == 0 && 1 / Math.round(-0.4) > 0, "round(-0.4) is +0");
check(Math.round(-0.5) == 0 && 1 / Math.round(-0.5) > 0, "round(-0.5) is +0, not -1");
check(Math.round(-0.6) == -1, "round(-0.6) is -1");
check(Math.round(-1.5) == -1, "round(-1.5) is -1, not -2");
check(Math.round(-2.5) == -2, "round(-2.5) is -2, not -3");
check(Math.round(0.5) == 1, "round(0.5) is 1");
check(Math.round(1.5) == 2, "round(1.5) is 2");
check(Math.round(2.5) == 3, "round(2.5) is 3");
check(Math.round(3.5) == 4, "round(3.5) is 4");
// The half-up form is observable through double rounding, which floor(x)+frac would miss.
check(Math.round(0.49999999999999994) == 1, "round(0.49999999999999994) is 1 (x+0.5 rounds to 1.0)");
check(Math.round(4503599627370497.0) == 4503599627370498, "round(2^52+1) is 2^52+2");
check(Math.round(1e20) == 1e20, "a magnitude past 2^53 is unchanged");
check(1 / Math.round(-0.0) > 0, "round(-0.0) is +0");
check(1 / Math.round(-1e-9) > 0, "round(-1e-9) is +0");
check(Math.round(Number.NEGATIVE_INFINITY) == Number.NEGATIVE_INFINITY, "round(-Infinity) is -Infinity");
check(Math.round(Number.POSITIVE_INFINITY) == Number.POSITIVE_INFINITY, "round(Infinity) is Infinity");
check(isNaN(Math.round(NaN)), "round(NaN) is NaN");

// The neighbours keep their own caliber: C ceil()/floor() already agree with AIR on -0.
check(1 / Math.ceil(-0.5) < 0, "ceil(-0.5) is -0");
check(1 / Math.floor(-0.0) < 0, "floor(-0.0) is -0");
check(Math.ceil(-0.5) == 0 && Math.floor(-0.0) == 0, "both compare equal to 0");