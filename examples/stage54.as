// stage54.as — typeof distinguishes Function values (v0.3.54).
//
// TweenLite's init() gates its ease selection on `typeof(vars.ease) == "function"`.
// A Function value must box with a distinct runtime tag so typeof returns
// "function" (not "object"), otherwise the user-supplied ease is silently ignored
// and the tween falls back to the default ease. This exercises that exact path:
// a function held in an Object and read back must both be typeof'd as "function"
// and be invocable through the boxed Function value.

function cubicEaseInOut(t:Number, b:Number, c:Number, d:Number):Number {
  if ((t/=d*0.5) < 1) return c*0.5*t*t*t + b;
  return c*0.5*((t-=2)*t*t + 2) + b;
}

trace("typeof-fn:", typeof(cubicEaseInOut) == "function");
trace("typeof-obj:", typeof({a:1}) == "object");

var f:Function = cubicEaseInOut;
trace("indirect t=1:", f(1, 0, 650, 2) == 325);
trace("indirect t=2:", f(2, 0, 650, 2) == 650);

var vars:Object = {ease: cubicEaseInOut};
trace("via-object typeof:", typeof(vars.ease) == "function");
var g:Function = vars.ease;
trace("via-object t=1:", g(1, 0, 650, 2) == 325);
trace("via-object t=2:", g(2, 0, 650, 2) == 650);
