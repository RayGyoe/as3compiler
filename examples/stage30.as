// stage30.as — Array 高阶方法 map/filter/sort/reverse + Array.NUMERIC。

// --- map(callback): 每个元素调用回调，返回新数组 ---
var m = [1, 2, 3].map(function(x:int) { return x * 2; });
trace(m.join(",") == "2,4,6");                    // true

// map 回调接收 (element, index, array) 三参数；用 index 验证序号正确传入
var m2 = [10, 20].map(function(x:int, i:int, a:Array) { return x + i; });
trace(m2.join(",") == "10,21");                   // true (10+0, 20+1)

// 用 array 参数验证整个数组被传入
var m3 = [5, 6].map(function(x:int, i:int, a:Array) { return x + a.length; });
trace(m3.join(",") == "7,8");                     // true (5+2, 6+2)

// --- filter(callback): 保留回调返回真值的元素 ---
var f = [1, 2, 3, 4, 5, 6].filter(function(x:int) { return x % 2 == 0; });
trace(f.join(",") == "2,4,6");                    // true

// --- sort(): 默认按字符串排序 ---
var s1 = [30, 1, 200, 7].sort();
trace(s1.join(",") == "1,200,30,7");              // true (string sort)

// --- sort(Array.NUMERIC): 数值排序 ---
var s2 = [30, 1, 200, 7].sort(Array.NUMERIC);
trace(s2.join(",") == "1,7,30,200");              // true

// --- reverse(): 就地反转 ---
var s3 = [30, 1, 200, 7].sort(Array.NUMERIC).reverse();
trace(s3.join(",") == "200,30,7,1");              // true

// --- sort(compareFunction): 自定义比较（降序）---
var s4 = [30, 1, 200, 7].sort(function(a:int, b:int) { return b - a; });
trace(s4.join(",") == "200,30,7,1");              // true

// --- Array.NUMERIC 常量值 ---
trace(Array.NUMERIC == 16);                       // true
