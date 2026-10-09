// swf-metadata.as — bracket/`[` disambiguation regressions (两个 parser 缺陷).
//
// 1) 包内 `[SWF(...)]` 用**不带引号的数字**实参（`frameRate = 60`）曾让解析器
//    死循环：parseMetadataIfPresent 因数字实参抛出并回滚，而 parsePackage 的 `[`
//    分支在回滚后不消费任何 token，while 原地空转（CPU 打满、永不返回）。
//    这里放在 `package {}` 体内正是旧缺陷的触发形态——放在文件顶层不会复现，
//    因为顶层会退化成数组字面量表达式语句后继续往下走。
//
// 2) 字符串字面量与括号同值：`"]"` 的 token value 也是 `"]"`，而 at() 只比 value
//    不比 kind，于是 `[ "]" ]` 被当成数组提前闭合。worlize/WebSocket.as:178 的
//    标点分隔符表正是这种写法（本轮真机命中）。下面逐个钉住。
//
// 期望值均为运行时断言（失败即 throw → 非零退出），不依赖人工比对输出。

package {
    [SWF(frameRate = 60, backgroundColor = "0x000000")]
    class SwfSkin {
        public var name:String = "swf";
    }
}

function check(cond:Boolean, msg:String):void {
    if (!cond) throw new Error("FAIL: " + msg);
}

// 标点分隔符表：每个元素都与某个括号/符号字符等值，旧 at() 缺陷下 `"]"` 会
// 提前结束数组。长度断言是核心（旧行为下长度/内容都错）。
var sep:Array = [ "(", ")", "<", ">", "@", ",", ";", ":", "/", "[", "]", "?", "=", "{", "}", " " ];
check(sep.length == 16, "punctuation table length is 16 (got " + sep.length + ")");
check(sep[0] == "(", "sep[0] is '(' (got " + sep[0] + ")");
check(sep[10] == "]", "sep[10] is ']' (got " + sep[10] + ")");
check(sep[9] == "[", "sep[9] is '[' (got " + sep[9] + ")");
check(sep[13] == "{", "sep[13] is '{' (got " + sep[13] + ")");
check(sep[14] == "}", "sep[14] is '}' (got " + sep[14] + ")");
check(sep.indexOf("]") == 10, "indexOf(']') is 10 (got " + sep.indexOf("]") + ")");

// 单独的形式：只含一个右方括号 / 左方括号 / 右大括号。
var closeBracket:Array = ["]"];
check(closeBracket.length == 1, "[\"]\"] has one element (got " + closeBracket.length + ")");
check(closeBracket[0] == "]", "[\"]\"][0] is ']' (got " + closeBracket[0] + ")");
var openBracket:Array = ["["];
check(openBracket.length == 1 && openBracket[0] == "[", "[\"[\"] round-trips");
var closeBrace:Array = ["}"];
check(closeBrace.length == 1 && closeBrace[0] == "}", "[\"}\"] round-trips");
var empty:Array = [];
check(empty.length == 0, "[] is still empty");

// 拼接以证明元素没有丢：join 的字符串里必须出现所有括号字符。
var joined:String = sep.join("");
check(joined.length == 16, "joined length is 16 (got " + joined.length + ")");
check(joined.indexOf("[") >= 0 && joined.indexOf("]") >= 0 && joined.indexOf("{") >= 0 && joined.indexOf("}") >= 0,
    "joined contains all bracket characters (got " + joined + ")");

// 包内带数字元数据的类仍然正常声明与实例化。
var skin:SwfSkin = new SwfSkin();
check(skin.name == "swf", "SwfSkin declared after numeric [SWF] metadata (got " + skin.name + ")");

trace("swf-metadata OK");