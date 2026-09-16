// fib.as — function definition, loop, arithmetic
function fib(n:int):int {
    if (n < 2) {
        return n;
    }
    var a:int = 0;
    var b:int = 1;
    var i:int = 2;
    while (i <= n) {
        var c:int = a + b;
        a = b;
        b = c;
        i++;
    }
    return b;
}

for (var k:int = 0; k < 15; k++) {
    trace("fib(", k, ") =", fib(k));
}
