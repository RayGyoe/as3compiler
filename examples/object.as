// Object literal: associative map (simplified Object).

var o = { x: 10, y: "hello", z: true };
trace(o.x);          // 10
trace(o.y);          // hello
trace(o.z);          // true

o.x = 99;
trace("set:", o.x);  // 99

o.x += 1;
trace("inc:", o.x);  // 100

var p = { nested: { a: 1, b: 2 } };
trace("nested:", p.nested.a, p.nested.b);  // 1 2

p.nested.b = 42;
trace("nested2:", p.nested.b);  // 42

var missing = o.nope;
trace("missing:", missing);  // null

var empty = {};
trace("empty is:", empty);  // [object Object]
