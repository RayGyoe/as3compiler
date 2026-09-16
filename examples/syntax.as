// 新语法扩展测试：uint、十六进制、do-while、switch、三元、break/continue、Infinity/NaN

var u:uint = 0xFF;                    // 十六进制整型字面量 = 255
trace("uint hex:", u);

// 三元运算符（右结合）
var a:int = 5;
var b:int = 3;
var max:int = a > b ? a : b;
trace("max:", max);

// do-while
var n:int = 0;
do {
    n++;
} while (n < 3);
trace("do-while n:", n);

// for + continue / break
var sum:int = 0;
for (var i:int = 0; i < 10; i++) {
    if (i % 2 == 0) continue;   // 跳过偶数
    if (i > 6) break;           // 到 7 停止
    sum += i;
}
trace("sum:", sum);              // 1 + 3 + 5 = 9

// switch（整数，走原生 C switch，支持 break）
var grade:int = 2;
switch (grade) {
    case 1: trace("one"); break;
    case 2: trace("two"); break;
    default: trace("other");
}

// switch（字符串，降级为 if/else 严格相等链）
var s:String = "b";
switch (s) {
    case "a": trace("A"); break;
    case "b": trace("B"); break;
    default: trace("?");
}

// Number 特殊值
var inf:Number = Infinity;
var nan:Number = NaN;
trace("inf:", inf);
trace("nan:", nan);

// uint 算术与复合赋值
var u2:uint = 10;
u2 += 5;
trace("u2:", u2);

// 字符串三元
var label:String = a > 0 ? "positive" : "zero";
trace("label:", label);
