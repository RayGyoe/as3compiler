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

trace("string-utf16-index OK");