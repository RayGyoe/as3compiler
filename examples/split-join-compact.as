// split-join-compact.as — split()/join() 的两条快路径（阶段四百四十）
//
// 阶段四百四十把 split/join 的**扫描**部分压实：
//   ① split 的结束位置只算一次 `strlen`（旧形状每个分片重算一次 `strlen(sep)` +
//      `strstr` 重新起扫），单字节分隔符改走 `memchr`（libc 的向量化搜索，
//      而 " " / "," / "\t" 正是最常见的那一类），多字节分隔符仍是 `strstr`；
//   ② join 的「量长」与「拷贝」两趟合成一趟：tag 3（字符串）的分片在量长时就把
//      指针与长度记下，拷贝趟不再重复 stringify + strlen。
//
// 这属于 AGENTS.md §1「翻译形态不变、只换实现」的运行时优化：结果、错误、顺序
// 一律不变。所以本示例钉的不是性能，而是**两条路径的边界语义**——下面的期望值
// 全部是 `adl 51.4.1` 跑同一份程序读出来的（temp/sjprobe/air，输出逐行一致）。
//
// 覆盖到的边界：
//   · 单字节分隔符：首/尾/连续分隔符都产生**空串分片**（不是被吞掉）
//   · 没有分隔符 / 分隔符比源串长：整串一个分片
//   · 空串 split：一个空分片（不是空数组）
//   · 非重叠匹配：'aaa'.split('aa') 是 ['', 'a']
//   · join：空数组、单元素（不插入分隔符）、空分隔符、>16 个元素（走 malloc 分片表
//     而不是栈上的 16 槽缓存）、混合类型（null / undefined / 数字 / 布尔 / 嵌套数组）
//   · 往返：split(sep).join(sep) 还原原文（含多字节分隔符与空分片）

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function parts(a:Array):String { return a.join("|"); }

// ---------------------------------------------------------- 1) 单字节分隔符（memchr）
var p1:Array = ",a,,b,".split(",");
check(p1.length == 5, "leading/trailing/doubled separators keep empty parts (got " + p1.length + ")");
check(parts(p1) == "|a||b|", "empty parts are empty strings, not swallowed (got [" + parts(p1) + "])");
check(p1[0] == "" && p1[4] == "", "both ends are empty strings");
check("abc".split(",").length == 1, "no separator -> one part");
check("abc".split(",")[0] == "abc", "...and it is the whole string");
check("".split(",").length == 1, "empty source -> one empty part, not an empty array");
check("".split(",")[0] == "", "...and that part is empty");
var p8:Array = "::a".split(":");
check(parts(p8) == "||a", "a separator run at the start yields one empty part per hit (got [" + parts(p8) + "])");

// ------------------------------------------------------ 2) 多字节分隔符（strstr 路径）
var p4:Array = "a--b--".split("--");
check(parts(p4) == "a|b|", "multi-byte separator splits whole tokens (got [" + parts(p4) + "])");
check(p4.length == 3, "...trailing separator still yields a trailing empty part");
var p5:Array = "abc".split("abcd");
check(p5.length == 1 && p5[0] == "abc", "a separator longer than the source matches nothing");
var p6:Array = "the quick".split("quick");
check(parts(p6) == "the |", "multi-byte match leaves the segments around it (got [" + parts(p6) + "])");
var p7:Array = "aaa".split("aa");
check(parts(p7) == "|a", "matches do not overlap (got [" + parts(p7) + "])");

// ---------------------------------------------------------------- 3) join 的两趟合一
check(["a", "b", "c"].join("--") == "a--b--c", "join inserts the separator between parts");
check(["a"].join("-") == "a", "a single element gets no separator");
check(["a", "b"].join("") == "ab", "an empty separator concatenates");
check([].join("-") == "", "an empty array joins to the empty string");
// >16 个元素：量长缓存从栈上 16 槽切到堆表，结果必须一字不差。
var big:Array = [];
for (var i:int = 0; i < 20; i++) big.push(i);
var bigJoin:String = big.join("-");
check(bigJoin.length == 49, "a 20-element join has the expected length (got " + bigJoin.length + ")");
check(bigJoin == "0-1-2-3-4-5-6-7-8-9-10-11-12-13-14-15-16-17-18-19", "a 20-element join keeps order");
// 混合 tag：null/undefined 元素贡献空串，其余走各自的 ToString，嵌套数组走 join(",")。
var mixed:Array = [1, null, undefined, "x", true, [1, 2]];
check(mixed.join("|") == "1|||x|true|1,2", "join stringifies each tag the ES3 way (got " + mixed.join("|") + ")");

// ------------------------------------------------------------------ 4) 往返不变
check("a::b::c".split("::").join("::") == "a::b::c", "multi-byte split/join round-trips");
check("a,,b".split(",").join(",") == "a,,b", "single-byte split/join round-trips empty parts");
check("".split(",").join(",") == "", "the empty source round-trips to empty");

trace("split-join-compact: 单字节/多字节分隔符与两趟合一 join 的边界语义 — assertions passed");