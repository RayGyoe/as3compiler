// string-utf16-index.as — String indices are UTF-16 CODE UNITS, not UTF-8 bytes
// (compiler-gaps.md G38). Until this stage `String.length` was strlen and
// `charCodeAt` was `(unsigned char)s[i]`, so a 60-character Chinese sentence
// reported length 180, `charCodeAt(0)` answered the lead byte 0xE4..0xE9, and
// `"中文".charCodeAt(i) >= 0x2E80` could never be true. AIR is the oracle here
// (AS3 spec: index = code unit); the numbers below were read off `adl 51.4.1`
// running the same program (temp/g38u16/air, output identical line for line).
//
// What the implementation does is NOT "store UTF-16": the backing store stays
// UTF-8 (every C boundary -- Skia, printf, paths, curl, JSON -- speaks UTF-8, and
// storing UTF-16 doubles ASCII memory and forces a transcode per crossing). Only
// the INDEX SPACE is translated, by a word-wise length plus a two-slot cursor
// that turns the ascending scan every text algorithm performs into ONE pass.
// Measured cost of that choice vs the byte semantics it replaces
// (temp/g38/bench2.c, 200-character strings):
//     .length      ASCII 1.3ns (was 1.5)   CJK 1.25ns (was 1.3, ANSWER WAS WRONG)
//     full scan    CJK 591ns               (was 808ns)
//     tokenize     CJK 328ns               (was 316ns)
// i.e. no operation got slower except a slice-shaped walk, which is within noise.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ------------------------------------------------------------- 1) length and index
var zh:String = "中文ab";
check(zh.length == 4, "length is code units, not bytes (got " + zh.length + ")");
check(zh.charCodeAt(0) == 0x4E2D, "charCodeAt(0) is 中, not its lead byte");
check(zh.charCodeAt(1) == 0x6587, "charCodeAt(1) is 文");
check(zh.charCodeAt(2) == 97, "charCodeAt crosses into ASCII at the right index");
// Out of range: AIR answers NaN (ES3), we answer 0 -- a SEPARATE divergence from the
// index space, registered in compiler-gaps.md (G39) rather than fixed here, so this
// example does not pin the wrong answer either way.
check(zh.charAt(0) == "中", "charAt returns a whole character");
check(zh.charAt(3) == "b", "charAt indexes by code unit");
check(zh.charAt(9) == "", "charAt out of range is empty");

// ---------------------------------------------------- 2) slicing never splits UTF-8
check(zh.substr(1, 2) == "文a", "substr by code units");
check(zh.substring(2) == "ab", "substring default end is the code-unit length");
check(zh.substring(3, 1) == "文a", "substring swaps a reversed range");
check(zh.slice(-2) == "ab", "slice counts negatives from the end");
check(zh.substr(0, -1) == "中文a", "substr counts a negative length back from the end");
check(zh.substring(1, 1) == "", "empty range is empty");
// The property that matters: a 1-unit slice of a 3-byte character is that
// character, never a broken byte sequence.
check(zh.substr(0, 1).length == 1, "1-unit slice of a CJK char has length 1");
check(zh.substr(0, 1).charCodeAt(0) == 0x4E2D, "and reads back as 中");

// --------------------------------------------------------------- 3) search returns
check(zh.indexOf("ab") == 2, "indexOf answers a code-unit index");
check(zh.indexOf("文") == 1, "indexOf of a CJK needle, not its byte offset");
check(zh.indexOf("zz") == -1, "absent needle is -1");
check(zh.indexOf("文", 2) == -1, "startIndex is a code-unit index too");
check(zh.lastIndexOf("b") == 3, "lastIndexOf answers a code-unit index");
check(zh.lastIndexOf("文") == 1, "lastIndexOf of a CJK needle");
var joined:String = "中a中";
check(joined.lastIndexOf("中") == 2, "lastIndexOf takes the LAST occurrence");

// ------------------------------------------------------------- 4) split("") and "\n"
var parts:Array = zh.split("");
check(parts.length == 4, "split('') splits into code units, not bytes");
check(parts[0] == "中" && parts[1] == "文" && parts[3] == "b", "split('') parts are characters");
var lines:Array = "中\n文\n".split("\n");
check(lines.length == 3, "split on a real separator still counts segments");

// ------------------------------------------------------- 5) ASCII keeps the fast path
var plain:String = "hello world";
check(plain.length == 11, "ASCII length");
check(plain.charCodeAt(1) == 101, "ASCII charCodeAt");
check(plain.indexOf("world") == 6, "ASCII indexOf");
check(plain.substr(6, 5) == "world", "ASCII substr");

// ------------------------------------------- 6) astral characters (surrogate pairs)
// One 4-byte character is TWO code units in AS3. `charAt` on either half must
// produce a 1-unit string (CESU-8 on the C side), and `charCodeAt` must read that
// half back unchanged -- which is what makes charAt/charCodeAt/length one index
// space. adl agrees with every line below.
var em:String = "\uD83D\uDE00";
check(em.length == 2, "one astral character is 2 code units");
check(em.charCodeAt(0) == 0xD83D, "high surrogate");
check(em.charCodeAt(1) == 0xDE00, "low surrogate");
check(em.charAt(0).length == 1, "charAt(high) is 1 code unit");
check(em.charAt(0).charCodeAt(0) == 0xD83D, "charAt(high) reads back as the high surrogate");
check(em.charAt(1).charCodeAt(0) == 0xDE00, "charAt(low) reads back as the low surrogate");
var rebuilt:String = em.charAt(0) + em.charAt(1);
check(rebuilt.length == 2, "the two halves concatenate to 2 units");
check(rebuilt.charCodeAt(0) == 0xD83D && rebuilt.charCodeAt(1) == 0xDE00, "and to the same pair");

// ------------------------------------- 7) length re-read in a loop condition
// A for-loop whose condition re-reads `.length` is the shape that turns an O(n)
// length into O(n^2); the runtime memoises the length per string pointer, so this
// stays linear without any emitter-side hoisting. Also exercises the memo across
// reassignment: every new string is a different pointer.
var sum:int = 0;
var k:int = 0;
var churn:String = "";
for (k = 0; k < 50; k++) churn += "文";
for (k = 0; k < churn.length; k++) sum += churn.charCodeAt(k);
check(sum == 50 * 0x6587, "scan over a built CJK string sums 50 x 文");
check(churn.length == 50, "length survived the loop");
churn = "ab";
check(churn.length == 2, "length follows reassignment (memo is keyed by pointer)");
churn = "中文中文";
check(churn.length == 4 && churn.charCodeAt(2) == 0x4E2D, "length and index after reassignment");

// ---------------------------------------------------------------- 8) concatenation
var mixed:String = "中文" + 12 + "ab";
check(mixed.length == 6, "concat keeps code-unit length (" + mixed.length + ")");
check(mixed.substr(0, 2) == "中文", "concat keeps the leading characters");
check(mixed.indexOf("ab") == 4, "concat keeps search indices in code units");

// --------------------------------- 9) from 落在代理对的下半（阶段四百四十五）
// 码元索引里代理对的两个半字符都是合法下标，但**字节偏移**只有一个：定位时只能
// 报这对的起点。于是 from 落在下半时，两件事必须显式处理，否则答案错在 before-from：
//   · 空针在 from 处就地命中（"<pair><pair>".indexOf("", 1) 是 1，不是 0）
//   · 非空针必须从这对**之后**开始找（.indexOf(pair, 1) 是 2 —— 起点 0 的那个
//     命中整个落在 from 之前，不合规）
// 下面每条期望值都由 `adl 51.4.1` 实测（temp/cjk/air/astral.as）。
var pair:String = "\uD834\uDD1E";                 // 𝄞：1 字符 / 2 码元 / 4 字节
var two:String = pair + pair;
check(two.length == 4, "two astral characters are 4 code units");
check(two.indexOf("", 0) == 0, "empty needle at 0");
check(two.indexOf("", 1) == 1, "empty needle on the LOW half stays at from, not the pair start");
check(two.indexOf("", 2) == 2, "empty needle at the second pair start");
check(two.indexOf("", 9) == 4, "empty needle past the end clamps to the length");
check(two.indexOf(pair, 1) == 2, "needle search from a low half starts AFTER the straddled pair");
check(two.indexOf(pair, 2) == 2, "needle search from the second pair start");
check(two.lastIndexOf(pair, 1) == 0, "lastIndexOf from a low half takes the pair that starts before it");
var at:String = "a" + pair + "b";                // 4 码元：a | hi | lo | b
check(at.length == 4, "ascii + astral + ascii is 4 code units");
check(at.charCodeAt(1) == 0xD834 && at.charCodeAt(2) == 0xDD1E, "the two halves read back separately");
check(at.indexOf("b", 1) == 3, "indexOf from the HIGH half still finds the following character");
check(at.indexOf("b", 2) == 3, "indexOf from the LOW half too");
check(at.substring(1, 3) == pair, "substring over both halves rebuilds the character");
check(at.substring(1, 2).length == 1, "substring of one half is 1 code unit");
check(at.slice(1).length == 3, "slice from the high half keeps 3 units");
check(at.substr(1, 1).length == 1, "substr of one half is 1 code unit");

// ------------------------------- 10) 采样检查点边界：跳转 >= 2048 码元（阶段四百四十五）
// 定位不必每次都从字节 0 数起；但跳得足够远时走的是**每 1024 码元一格的采样表**，
// 而一格记的是「首个 >= 边界的字符起点」—— 代理对宽 2 码元，可能正好**跨过**边界。
// 下例把 4 字节字符摆在 2047/2048 上：高位在 2047，低位 2048 就是一个表边界。
// 先访问 0 再直接跳到 2048，才真的走表（相邻访问只会续游标）。
var seam:String = "";
for (var i:int = 0; i < 2047; i++) seam += "a";
seam += pair + "b";
check(seam.length == 2050, "the seam string is 2050 code units");
check(seam.charCodeAt(0) == 97, "warm the cursor at unit 0");
check(seam.charCodeAt(2048) == 0xDD1E, "a >= 2048-unit jump must land on the LOW half, not the next character");
check(seam.charCodeAt(2047) == 0xD834, "and the unit before it is the high half");
check(seam.charCodeAt(2049) == 98, "the character after the pair is unaffected");
// 深一点的位置上，跳转读数必须与顺序走到的读数一致（表只是跳过前缀，不改答案）。
check(seam.charCodeAt(0) == 97, "back to a warm short access");
check(seam.charCodeAt(1600) == 97, "mid-string ASCII in front of the pair");
check(seam.charCodeAt(2049) == 98, "jump forward again after a low access");

trace("string-utf16-index OK");