// stage19.as — 字符串 join 优化（memcpy 指针推进）+ 有意简化项验证。

// 1) Array.join 优化后仍正确：大量元素拼接。
var parts:Array = [];
var k:int = 0;
while (k < 1000) {
  parts.push("ab");
  k = k + 1;
}
var joined:String = parts.join("");
trace(joined.length);        // 2000

// 2) Vector.join 优化后仍正确。
var v:Vector.<int> = new Vector.<int>();
var m:int = 0;
while (m < 10) {
  v.push(m);
  m = m + 1;
}
trace(v.join(","));          // 0,1,2,3,4,5,6,7,8,9
trace(v.join("-"));          // 0-1-2-3-4-5-6-7-8-9

// 3) 有意简化：闭包快照捕获（闭包内修改不影响外层，README 已注明）。
function makeCounter():Function {
  var n = 0;
  return function() { return ++n; };
}
var c1:Function = makeCounter();
var c2:Function = makeCounter();
trace(c1());                 // 1
trace(c1());                 // 2
trace(c2());                 // 1（独立计数）

// 4) 有意简化：数组越界读返回 null（AS3 应为 undefined）。
var arr:Array = [1, 2, 3];
trace(arr[99] == null);      // true
