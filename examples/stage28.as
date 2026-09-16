// stage28.as — Array() / Object() / Vector() 构造器形式（含无 new 的函数式调用）。

// --- new Array(...) 构造 ---
trace(new Array().length == 0);                       // true (empty)
trace(new Array(3).length == 3);                      // true (sized, not [3])
trace(new Array(1, 2, 3).join(",") == "1,2,3");       // true (element list)
trace(new Array("a", "b").length == 2);               // true

// --- Array(...) 无 new 函数式调用（等价 new）---
trace(Array().length == 0);                           // true
trace(Array("a", "b").length == 2);                   // true
trace(Array("x", "y", "z").join("-") == "x-y-z");     // true

// --- new Object() / Object() 空对象，可赋值读写 ---
var o1 = new Object();
o1.x = 10;
o1.name = "obj1";
trace(o1.x == 10);                                    // true
trace(o1.name == "obj1");                             // true

var o2 = Object();
o2.tag = "empty";
trace(o2.tag == "empty");                             // true

// --- Object(x) 有参恒等语义：对象类型原样返回 ---
var arr = [1, 2, 3];
trace(Object(arr).length == 3);                       // true (same array)

// --- Object(x) 有参恒等语义：primitive 装箱为 any ---
trace(Object(42) == 42);                              // true
trace(Object("hello") == "hello");                    // true
trace(Object(true) == true);                          // true

// --- Vector.<T>() 无 new 函数式调用（等价 new Vector.<T>）---
var v = Vector.<int>(2);
trace(v.length == 2);                                 // true
trace(v[0] == 0);                                     // true (int default fill)
trace(v[1] == 0);                                     // true

var vs = Vector.<String>(2);
vs[0] = "a";
trace(vs.length == 2);                                // true
trace(vs[0] == "a");                                  // true
