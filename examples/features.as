// features.as — comparisons, logical ops, division, modulo, unary, strings
var a:int = 7;
var b:int = 3;

trace("a / b =", a / b);          // Number division (AS3 semantics)
trace("a % b =", a % b);
trace("a > b =", a > b);
trace("a == b =", a == b);
trace("a != b =", a != b);
trace("-a =", -a);

var x:int = 0;
trace("x++ =", x++);              // postfix: prints 0, x becomes 1
trace("++x =", ++x);              // prefix: prints 2
trace("x =", x);

var s1:String = "abc";
var s2:String = "abc";
var s3:String = "abd";
trace("s1 == s2 =", s1 == s2);
trace("s1 == s3 =", s1 == s3);
trace("s1 != s3 =", s1 != s3);

var hot:Boolean = true;
var ready:Boolean = false;
trace("hot && !ready =", hot && !ready);
trace("hot || ready =", hot || ready);

if (a > b && s1 == s2) {
    trace("compound condition passed");
}
