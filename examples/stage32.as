// stage32.as — Date 构造器重载与格式化方法。

// --- 当前时间 ---
var now = new Date();
trace(now.getTime() > 0);   // true

// --- 日历组件构造 (month 0-based) ---
var d = new Date(2024, 0, 15, 10, 30, 0, 0);
trace(d.getFullYear() == 2024);   // true
trace(d.getMonth() == 0);          // true
trace(d.getDate() == 15);          // true
trace(d.getHours() == 10);         // true
trace(d.getMinutes() == 30);       // true

// --- epoch 毫秒往返 ---
var ts:Number = d.getTime();
var d2 = new Date(ts);
trace(d2.getDate() == 15);          // true
trace(d.getTime() == d2.getTime()); // true

// --- Date.parse 静态方法 ---
var parsed:Number = Date.parse("2024/01/15");
trace(parsed > 0);   // true
var d3 = new Date(parsed);
trace(d3.getDate() == 15);   // true

// --- 字符串构造 ---
var d4 = new Date("2024-01-15");
trace(d4.getDate() == 15);   // true

// --- 人类可读格式化 ---
trace(d.toDateString() == "Mon Jan 15 2024");   // true
trace(d.toUTCString().indexOf("GMT") >= 0);     // true
