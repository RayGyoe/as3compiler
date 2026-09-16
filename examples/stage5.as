// stage5.as — default parameters, rest parameters, function values

// default parameters (applied at the call site when an argument is omitted)
function greet(name:String, greeting:String = "Hello"):String {
    return greeting + ", " + name;
}

function add(a:int, b:int = 10):int {
    return a + b;
}

// rest parameters: trailing arguments are packed into an Array
function sum(...nums:Array):Number {
    var total:Number = 0;
    for each (var n in nums) {
        total = total + n;
    }
    return total;
}

// function values: a Function can be passed as an argument
function apply(f:Function, x:int, y:int):int {
    return f(x, y);
}

function multiply(a:int, b:int):int {
    return a * b;
}

// anonymous function expression (uses only its own parameters — no closure)
var square:Function = function(n:int):int {
    return n * n;
};

trace(greet("Alice"));          // Hello, Alice
trace(greet("Bob", "Hi"));      // Hi, Bob
trace(add(5));                  // 15
trace(add(5, 3));               // 8
trace(sum(1, 2, 3, 4));         // 10
trace(apply(multiply, 6, 7));   // 42
trace(square(5));              // 25
var f:Function = multiply;
trace(f(6, 7));                 // 42
