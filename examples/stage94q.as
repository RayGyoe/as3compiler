// stage94q.as — 阶段九十四·十八：字符串字面量的转义序列解码。
//
// 触发：阶段九十四·十七 的 IME 探针顺带发现 `"\u4f60\u597d"` 在过去被当成字面
// `u4f60u597d` 塞进字符串（词法器只认识 `\n \t \r \\ \" \'`，其余一律「保留字符
// 本身」），于是 `\uXXXX` / `\xXX` / `\b` / `\f` / `\v` / 续行全部错。
//
// adl 51.4.1 实测（证据台 temp/escprobe/Esc.as，日志 /tmp/esc_out.txt）——
//   * `"\u4f60\u597d"`：`length` = 2（UTF-16 码元）、`charCodeAt(0)` = 0x4F60、
//     `charCodeAt(1)` = 0x597D ⇒ `\uXXXX` **必须解码**（非法 hex 是编译错误）。
//   * `"\x41\x7a"` = `"Az"`（65 / 122）⇒ `\xXX` 是**两位**十六进制。
//   * `"\b\f\v"` 的码元 = 8 / 12 / 11 ⇒ 三个都是**单码元**转义。
//   * `"\q\z\8"` = `"qz8"` ⇒ 未知转义**丢掉反斜杠、保留字符本身**。
//   * `"a\<LF>b"`：`length` = 2 = `"ab"` ⇒ `\` + 换行是**续行**（不产生字符）。
//   * `"p\0q"`：`length` = 3、码元 112 / **48** / 113 ⇒ `\0` 是**字符 '0'**，
//     **不是** NUL —— AS3 弃用了 ES3 的八进制/NUL 转义（实测口径，不再猜）。
//   * `"\ud83d\ude00"`：`length` = 2 ⇒ 代理对由两个 `\u` 拼出，与我们「AS3 字符串
//     即 UTF-16 码元序列、JS 字符串同构」的建模一致。
//   * `mxmlc` **拒绝**字符串里的裸换行（temp/escprobe/Raw.as：报「语法错误: 此处
//     应该有一个"分号"或一个"新行"」）⇒ 词法器对裸换行报 LexError（钉子见 test.ts）。
//
// 与 C 的差异（AGENTS.md §2.4 红线）：C 的 `"\u4f60"` 是**通用字符名**，编码进
// 执行字符集（UTF-8）与 AS3 一致，但 C 还会静默接受 `"\u0000"` 截断字符串、
// 八进制 `"\0"` 表示 NUL，二者都与 AS3 相反；所以解码**在词法器里做完**，生成 C
// 时字面量已经只含最终字节（对含引号/反斜杠的串按 C 规则再转义），C 编译器看不到
// 任何 `\u`。
//
// 已知偏差（**既定口径**，不在本阶段改）：本运行时的 `String.length` /
// `charCodeAt` / `indexOf` 是**UTF-8 字节**偏移（见 README「当前限制」），故
// `"\u4f60\u597d".length` 这里是 6（AIR 是 2）、`charCodeAt(0)` 这里是首字节
// 0xE4（AIR 是 0x4F60）。本示例因此只在**字节层**断言：转义解码后的串与同一份
// 源里的等值字面量逐字节相等。
import flash.display.*;

var failCount:int = 0;
function check(cond:Boolean, msg:String):void {
	if (!cond) { failCount++; trace("FAIL: " + msg); }
}
function eq(actual:*, expected:*, msg:String):void {
	if (actual != expected) { failCount++; trace("FAIL: " + msg + " (got " + actual + ", want " + expected + ")"); }
}

// A：\uXXXX 解码 —— 与源文件里的等价 UTF-8 字面量逐字节相等。
var u:String = "\u4f60\u597d";
eq(u, "你好", "A: \\u4f60\\u597d decodes to the same bytes as the literal 你好");
eq(u.length, 6, "A: length is the BYTE length in this runtime (6 for two CJK chars)");
// A2：`\u0000` 解码出的是真正的 NUL 字节。AS3 的字符串是 UTF-16 码元序列，
// `"a\u0000b"` 在 AIR 里长 **3**；本运行时的字符串是 **C 串**，遇 NUL 即止，
// 所以这里只能是 1 —— 这是与 AIR 的**既定偏差**（已登记 TODO 遗留行），本示例
// 把可观测到的那一面钉住，免得以后有人以为 `\u0000` 没被解码。
var z:String = "a\u0000b";
eq(z.length, 1, "A: an embedded NUL truncates (C string; AIR reports 3 -- known divergence)");

// B：\xXX 恰好两位十六进制，且大小写都认。
eq("\x41\x7a", "Az", "B: \\x41\\x7a = Az");
eq("\x6b", "k", "B: lowercase hex digits are accepted");
eq("\x4A", "J", "B: uppercase hex digits are accepted");

// C：\b / \f / \v 是单码元（8 / 12 / 11），与 \t \n \r 同类。
var ctl:String = "\b\f\v";
eq(ctl.length, 3, "C: \\b\\f\\v are three single-code-unit escapes");
eq(ctl.charCodeAt(0), 8, "C: \\b is 8");
eq(ctl.charCodeAt(1), 12, "C: \\f is 12");
eq(ctl.charCodeAt(2), 11, "C: \\v is 11");

// D：未知转义丢掉反斜杠、保留字符本身（ES3 口径）。
eq("\q\z\8", "qz8", "D: an unknown escape keeps the character, not the backslash");
eq("\a\e\.", "ae.", "D: punctuation falls through the same rule");

// E：\0 不是 NUL，而是字符 '0'（AS3 弃用八进制/NUL 转义）。
var nul:String = "p\0q";
eq(nul.length, 3, "E: p\\0q is three characters long");
eq(nul.charCodeAt(1), 48, "E: the middle character is '0' (48), not a NUL");
eq(nul, "p0q", "E: \\0 is the character zero");

// F：转义与非转义内容混在一个串里，逐段都正确。
eq("\u0041\u0042\x43\-D", "ABC-D", "F: escapes and plain text mix in one literal");
eq("\t\n\r".length, 3, "F: \\t \\n \\r are still single escapes (regression)");
eq("\\\"\'".length, 3, "F: backslash, quote and apostrophe still escape themselves");

// G：代理对由两个 \u 拼出，与本运行时的 UTF-8 编码一致（4 字节）。
var emoji:String = "\ud83d\ude00";
eq(emoji.length, 4, "G: a surrogate pair is one 4-byte UTF-8 sequence here");
eq(emoji, "😀", "G: \\ud83d\\ude00 reassembles to the same bytes as the literal emoji");

// H：反斜杠 + 换行 = 续行，不产生字符。
var cont:String = "a\
b";
eq(cont, "ab", "H: a backslash before a newline is a line continuation");
eq(cont.length, 2, "H: the continuation contributes no character");

// I：续行在 \r\n 行尾也成立（词法器只吞掉行终止符本身）。
var cont2:String = "x\
y";
eq(cont2, "xy", "I: the continuation survives the source file's own line ending");

if (failCount == 0) trace("stage94q ok");
else trace("stage94q FAILED: " + failCount);