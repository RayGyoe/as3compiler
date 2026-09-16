// stage18.as — 基本类型 is/as 运行时类型测试。

// 1) 静态标量类型：is 编译期求值。
var i:int = 5;
trace(i is int);          // true
trace(i is Number);       // true（int 是 Number 子类型）
trace(i is String);       // false
trace(i is Boolean);      // false

var n:Number = 3.14;
trace(n is Number);       // true
trace(n is int);          // false（Number 不是 int）

var s:String = "hi";
trace(s is String);       // true
trace(s is Number);       // false

var b:Boolean = true;
trace(b is Boolean);      // true
trace(b is Number);       // false

// 2) 数组元素是 any（动态装箱）：运行时 tag 检查。
var a:Array = [5, "hi", true];
trace(a[0] is int);       // true（number tag）
trace(a[0] is Number);    // true
trace(a[0] is String);    // false
trace(a[1] is String);    // true
trace(a[2] is Boolean);   // true
trace(a[2] is Number);    // false

// 3) as 基本类型（静态兼容转换）。
trace((5 as Number));     // 5
trace(("hi" as String));  // hi
