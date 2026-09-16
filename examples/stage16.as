// stage16.as — String.replace（字符串版）与 Number 格式化方法。

// 1) String.replace：字符串 searchValue 只替换第一个匹配。
trace("a-b-c".replace("-", "_"));      // a_b-c
trace("hello world".replace("world", "AS3"));  // hello AS3
trace("abc".replace("x", "y"));        // abc（无匹配，原样返回）

// 2) Number.toFixed：定点，digits 位小数。
trace((1/3).toFixed(2));               // 0.33
trace((3.14159).toFixed(3));           // 3.142
trace((2.5).toFixed(0));               // 2（或 3，依舍入方式）

// 3) Number.toExponential：科学计数法，去指数前导零。
trace((1234.5678).toExponential(2));   // 1.23e+3
trace((0.00123).toExponential(2));     // 1.23e-3
trace((1.0).toExponential(2));          // 1.00e+0

// 4) Number.toPrecision：有效数字位数。
trace((1234.5678).toPrecision(4));     // 1235
trace((0.0012345).toPrecision(3));     // 0.00123
trace((1/3).toPrecision(3));           // 0.333
