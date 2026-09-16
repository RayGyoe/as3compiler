// stage53.as — self-modifying assignment sequencing (v0.3.54).
//
// Penner-style easing formulas write a parameter inside a larger arithmetic
// expression (`t/=d`, `t=t/d-1`, `--t`). AS3 evaluates operands strictly
// left-to-right; C leaves them unsequenced, so `c*(t/=d)*t*t` would be UB
// unless the compiler hoists the write into a sequenced prelude statement.
// These inline copies exercise exactly that path.
function cubicEaseIn(t:Number, b:Number, c:Number, d:Number):Number {
  return c*(t/=d)*t*t + b;
}
function cubicEaseOut(t:Number, b:Number, c:Number, d:Number):Number {
  return c*((t=t/d-1)*t*t + 1) + b;
}
function cubicEaseInOut(t:Number, b:Number, c:Number, d:Number):Number {
  if ((t/=d*0.5) < 1) return c*0.5*t*t*t + b;
  return c*0.5*((t-=2)*t*t + 2) + b;
}
function quadEaseOut(t:Number, b:Number, c:Number, d:Number):Number {
  return -c*(t/=d)*(t-2) + b;
}
function quadEaseInOut(t:Number, b:Number, c:Number, d:Number):Number {
  if ((t/=d*0.5) < 1) return c*0.5*t*t + b;
  return -c*0.5*((--t)*(t-2) - 1) + b;
}

trace("cubicInOut t=0:", cubicEaseInOut(0,0,650,2) == 0);
trace("cubicInOut t=1:", cubicEaseInOut(1,0,650,2) == 325);
trace("cubicInOut t=2:", cubicEaseInOut(2,0,650,2) == 650);
trace("cubicIn t=2:", cubicEaseIn(2,0,650,2) == 650);
trace("cubicOut t=2:", cubicEaseOut(2,0,650,2) == 650);
trace("quadInOut t=1:", quadEaseInOut(1,0,650,2) == 325);
trace("quadInOut t=2:", quadEaseInOut(2,0,650,2) == 650);
trace("quadOut t=2:", quadEaseOut(2,0,650,2) == 650);
