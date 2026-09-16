// stage31.as — 顶层 JSON 类 stringify / parse。

// --- JSON.stringify: 对象字面量 → JSON 字符串 ---
var s1 = JSON.stringify({ name: "Alice", age: 30, active: true });
trace(s1 == '{"name":"Alice","age":30,"active":true}');  // true

// --- JSON.stringify: 数组字面量 ---
var s2 = JSON.stringify([1, 2, 3]);
trace(s2 == "[1,2,3]");  // true

// --- JSON.stringify: 原始类型 ---
trace(JSON.stringify("hi") == '"hi"');       // true
trace(JSON.stringify(5) == "5");             // true
trace(JSON.stringify(true) == "true");       // true
trace(JSON.stringify(null) == "null");       // true

// --- JSON.stringify: 嵌套对象/数组 ---
var nested = { user: { id: 7, roles: ["admin", "editor"] } };
trace(JSON.stringify(nested) == '{"user":{"id":7,"roles":["admin","editor"]}}');  // true

// --- JSON.parse: 对象 → 动态访问属性 ---
var obj = JSON.parse('{"name":"Alice","age":30,"active":true}');
trace(obj.name == "Alice");   // true
trace(obj.age == 30);         // true
trace(obj.active == true);    // true

// --- JSON.parse: 数组 → 隐式转 Array ---
var arr:Array = JSON.parse("[1,2,3]");
trace(arr.length == 3);   // true
trace(arr[0] == 1);       // true
trace(arr[2] == 3);       // true

// --- JSON.parse: 原始类型 ---
trace(JSON.parse("42") == 42);        // true
trace(JSON.parse('"str"') == "str");  // true
trace(JSON.parse("false") == false);  // true

// --- 往返：对象 → stringify → parse → 属性 ---
var round = JSON.parse(JSON.stringify({ x: 1, y: "two" }));
trace(round.x == 1);       // true
trace(round.y == "two");   // true

// --- 嵌套数组访问（隐式转 Array）---
var nestedArr = JSON.parse('{"tags":["a","b"]}');
var tags:Array = nestedArr.tags;
trace(tags.length == 2);   // true
trace(tags[1] == "b");     // true
