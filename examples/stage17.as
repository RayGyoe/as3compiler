// stage17.as — Vector.<T> 扩展：join / indexOf / length 赋值 / 带参构造。

// 1) join
var v:Vector.<int> = new Vector.<int>();
v.push(1);
v.push(2);
v.push(3);
trace(v.join(","));          // 1,2,3

// 2) indexOf
trace(v.indexOf(2));         // 1
trace(v.indexOf(99));        // -1

// 3) length 赋值（收缩）
v.length = 2;
trace(v.length);             // 2
trace(v.join("-"));          // 1-2

// 4) 带参构造（length, fixed）——fixed 标志本子集接受但不强制。
var w:Vector.<int> = new Vector.<int>(3, true);
trace(w.length);             // 3
trace(w.join(","));          // 0,0,0

// 5) 字符串 Vector 的 join 与 indexOf。
var s:Vector.<String> = new Vector.<String>();
s.push("a");
s.push("b");
s.push("c");
trace(s.join("|"));          // a|b|c
trace(s.indexOf("b"));       // 1
trace(s.indexOf("z"));       // -1
