// string-ascii-scan.as — 码元翻译的 **ASCII 快路径**（阶段四百四十一）
//
// 索引空间是 UTF-16 码元（compiler-gaps.md G38，见 string-utf16-index.as），索引
// 存放仍是 UTF-8，所以每次 `indexOf` / `lastIndexOf` / `charAt` 都要在「码元 ↔ 字节」
// 之间翻译。ASCII 串上这两个空间**完全重合**，于是翻译可以塌成恒等：
//
//   ① `as_u16_prefix_ascii`：8 字节一字的高位置探测，一次判定前缀是不是纯 ASCII；
//   ② `as_u16_unit_of` / `as_u16_locate`：命中探测就直接返回偏移（不再逐字符走前缀）；
//   ③ `as_str_lastIndexOf_from`：命中探测就走**反向字节扫描**（旧实现只能正向逐字符走，
//      因为倒着走每个候选都要付一次字节→码元翻译）。
//
// 这是 AGENTS.md §1「翻译形态不变、只换实现」的运行时优化：结果、错误、边界一律不变。
// 所以本示例钉的是**两条路径的答案**：ASCII 快路径与它旁边那条通用路径必须给出同一个
// 码元索引。期望值全部是 `adl 51.4.1` 跑同一份程序读出来的
// （temp/u16probe/air，25 行输出与 temp/u16probe/ours.txt 逐行一致）。
//
// 覆盖到的边界：
//   · 纯 ASCII：indexOf / lastIndexOf（含 from 的限制、from 与最后一次匹配的关系）
//   · CJK（1 字符 3 字节）：翻译真的要做，且必须与 ASCII 路径给出同一套索引
//   · 星光面（1 字符 2 码元）：码元索引与字节、与字符计数三者都不同
//   · 混合串（ASCII + 重音字母）：翻译只在非 ASCII 段发生
//   · 边界：空针返回 clamp 后的 from；负 from 的 lastIndexOf 直接 -1；
//     `from` 落在星光面对的内涵里；针比源串长；空串
//   · 大 ASCII 串（≈180 KB）：这是快路径真正兑现的地方（探针 temp/asciiprobe：
//     38 ms → 11 ms，交错 A/B 中位 −71%），也是「索引不是字节偏移」的回归证据

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ---------------------------------------------------------- 1) 纯 ASCII（走快路径）
var t:String = "the quick brown fox";
check(t.indexOf("fox") == 16, "ASCII indexOf");
check(t.indexOf("c", 0) == 7, "ASCII indexOf with startIndex");
check(t.lastIndexOf("o") == 17, "ASCII lastIndexOf");
// from=10 时 'o' 只在 17（>10）出现：最后一个**起点** <= 10 的匹配不存在
check(t.lastIndexOf("o", 10) == -1, "ASCII lastIndexOf honours from");
check(t.lastIndexOf("fox", 100) == 16, "ASCII lastIndexOf clamps a large from down to len");
check(t.lastIndexOf("zz") == -1, "ASCII lastIndexOf misses");
check("aaa".lastIndexOf("aa") == 1, "non-overlapping from the right: last start that fits");
check("aaa".lastIndexOf("aa", 0) == 0, "from=0 only allows a match at 0");
check("abcabc".lastIndexOf("abc", 2) == 0, "from cuts the second occurrence off");
check("abcabc".lastIndexOf("abc", 5) == 3, "from keeps the second occurrence");
check("abcdef".lastIndexOf("ef", 4) == 4, "match must FIT in the string, start <= from");
check("abcdef".lastIndexOf("cd", 2) == 2, "start == from is allowed");
check("x".lastIndexOf("x", 0) == 0, "single character at index 0");

// ---------------------------------------------------------- 2) 空针 / 负 from / 空串
check("abc".lastIndexOf("", 2) == 2, "empty needle matches at the clamped from");
check("abc".lastIndexOf("", 5) == 3, "empty needle: from clamps to length");
check("abc".lastIndexOf("a", -1) == -1, "negative from is -1, NOT clamped to 0");
check("abc".lastIndexOf("abcd") == -1, "needle longer than the string");
check("".lastIndexOf("a") == -1, "empty haystack");

// ---------------------------------------------------------- 3) CJK（快路径必须落空）
var zh:String = "日本語テキスト";
check(zh.lastIndexOf("語") == 2, "CJK lastIndexOf (code-unit index, not byte offset)");
check(zh.indexOf("語") == 2, "CJK indexOf");
check(zh.length == 7, "CJK length counts code units");
check(zh.charAt(2) == "語", "CJK charAt");
check("日本語abc".lastIndexOf("c") == 5, "CJK prefix, ASCII tail: translation really happens");
check("日本語abc".indexOf("abc", 2) == 3, "CJK prefix: startIndex is in code units");

// ---------------------------------------------------------- 4) 星光面（1 字符 = 2 码元）
var emo:String = "😀a😀";
check(emo.length == 5, "astral: 3 characters, 5 code units");
check(emo.indexOf("a") == 2, "astral indexOf after a surrogate pair");
check(emo.lastIndexOf("😀") == 3, "astral lastIndexOf returns the LOW-half start");
check("😀😀".lastIndexOf("😀", 1) == 0, "from inside the first pair still matches it");
check("😀😀😀".lastIndexOf("😀", 5) == 4, "from between pairs");
check("a😀b".indexOf("b") == 3, "astral: 1 + 2 units before the ASCII tail");

// ---------------------------------------------------------- 5) 混合串：翻译只在非 ASCII 段
var mix:String = "aébc";
check(mix.lastIndexOf("b") == 2, "mixed: accented Latin shifts the byte offset");
check(mix.lastIndexOf("é") == 1, "mixed: the accented character itself");
check(mix.length == 4, "mixed length is code units");

// ---------------------------------------------------------- 6) 大 ASCII 串：快路径兑现处
var line:String = "the quick brown fox jumps over the lazy dog";
var big:String = "";
for (var k:int = 0; k < 4000; k++) { big += line + "\n"; }
var bigLen:int = big.length;
var lineLen:int = 44;              // 43 characters + "\n"
var lastStart:int = bigLen - lineLen;
check(bigLen == 4000 * lineLen, "big ASCII length is code units == bytes");
check(big.indexOf("lazy") == 35, "big: first line");
check(big.indexOf("lazy", lastStart - 1) == lastStart + 35, "big: last line is found");
check(big.lastIndexOf("fox") == lastStart + 16, "big: lastIndexOf from the end");
check(big.lastIndexOf("fox", 100000) == int(100000 / lineLen) * lineLen + 16, "big: from in the middle");
check(big.charAt(90000) == "j", "big: random access charAt");
check(big.indexOf("日本語") == -1, "big: non-ASCII needle never matches ASCII text");

trace("string-ascii-scan: OK");