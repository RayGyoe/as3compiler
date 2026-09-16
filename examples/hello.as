// hello.as — expressions, strings, control flow
var name:String = "TypeAS";
var n:int = 6 * 7;
var pi:Number = 3.14159;
var ok:Boolean = true;

trace("hello", name);
trace("6 * 7 =", n);
trace("pi ~=", pi);
trace("ok =", ok);

var s:String = name + " rocks " + n + " times";
trace(s);

if (n > 40) {
    trace("n is big");
} else {
    trace("n is small");
}
