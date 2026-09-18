// stage66.as — Vector.<T> 高阶/序列方法补齐 (slice/concat/splice/forEach/map/
// filter/sort/reverse) 与字面量 `new <T>[...]`。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- Vector 字面量 new <T>[...] ---
var lit:Vector.<int> = new <int>[1, 2, 3];
check(lit.length == 3, "literal length");
check(lit[0] == 1 && lit[1] == 2 && lit[2] == 3, "literal elements");

var lits:Vector.<String> = new <String>["a", "b"];
check(lits.length == 2 && lits[0] == "a" && lits[1] == "b", "string literal");

// --- slice(from, to) ---
var a:Vector.<int> = new <int>[1, 2, 3, 4, 5];
var sl:Vector.<int> = a.slice(1, 4);
check(sl.length == 3 && sl[0] == 2 && sl[1] == 3 && sl[2] == 4, "slice range");
check(a.length == 5, "slice does not mutate source");

// --- concat(other) ---
var cc:Vector.<int> = a.concat(new <int>[6, 7]);
check(cc.length == 7 && cc[5] == 6 && cc[6] == 7, "concat");

// --- splice(start, deleteCount, ...items) ---
var sp:Vector.<int> = new <int>[1, 2, 3, 4, 5];
var removed:Vector.<int> = sp.splice(1, 2, 9, 8);
check(removed.length == 2 && removed[0] == 2 && removed[1] == 3, "splice removed");
check(sp.length == 5 && sp[0] == 1 && sp[1] == 9 && sp[2] == 8 && sp[3] == 4 && sp[4] == 5, "splice inserted");

// --- forEach(callback): 引用累加器（闭包改对象内容可回传）---
var fe:Vector.<int> = new <int>[1, 2, 3];
var acc:Vector.<int> = new <int>[];
fe.forEach(function(x:int):void { acc.push(x); });
check(acc.length == 3 && acc[0] == 1 && acc[2] == 3, "forEach pushes every element");

// --- map(callback) ---
var m:Vector.<int> = fe.map(function(x:int):int { return x * 2; });
check(m.length == 3 && m[0] == 2 && m[1] == 4 && m[2] == 6, "map");

// --- filter(callback) ---
var f:Vector.<int> = new <int>[1, 2, 3, 4, 5, 6].filter(function(x:int):Boolean { return x % 2 == 0; });
check(f.length == 3 && f[0] == 2 && f[1] == 4 && f[2] == 6, "filter");

// --- sort() 默认数值（Vector 元素为 int）---
var sn:Vector.<int> = new <int>[30, 1, 200, 7];
sn.sort();
check(sn[0] == 1 && sn[1] == 7 && sn[2] == 30 && sn[3] == 200, "sort numeric default");

// --- sort(compareFunction) 自定义降序 ---
var sc:Vector.<int> = new <int>[30, 1, 200, 7];
sc.sort(function(x:int, y:int):int { return y - x; });
check(sc[0] == 200 && sc[1] == 30 && sc[2] == 7 && sc[3] == 1, "sort custom desc");

// --- sort() 默认字符串（Vector 元素为 String）---
var ss:Vector.<String> = new <String>["banana", "apple", "cherry"];
ss.sort();
check(ss[0] == "apple" && ss[1] == "banana" && ss[2] == "cherry", "sort string default");

// --- reverse() ---
var rv:Vector.<int> = new <int>[1, 2, 3];
rv.reverse();
check(rv[0] == 3 && rv[1] == 2 && rv[2] == 1, "reverse");
