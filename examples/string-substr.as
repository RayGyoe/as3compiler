// string-substr.as — `String.prototype.substr` 必须按 **AVM2** 而不是 ES3 实现。
//
// AVM2 的 `String::AS3_substr` 把 `start` 与 `start + count` 两处**都**过一遍
// ClampIndex（负数按「从尾部回算」处理，仍越界才夹到 0；见 avmplus
// core/StringObject.cpp + core/NativeObjectHelpers.h）。于是 `substr(0, -3)` 等于
// 「砍掉最后 3 个字符」，而 ES3 规定负长度 → 空串。我们原来按 ES3 把 len 夹到 0，
// 真应用里 myMeetingRenderers 的 `start_at.substr(0,-3)` 就整条时间被吃掉，
// 卡片上只剩「开始时间：」（用户报的「这个时间为什么没显示」）。
//
// 参考值直接来自 avmplus 实现：
//   clampIndex(n) = n<0 ? (n+len<0 ? 0 : n+len) : (n>len ? len : n)
//   start = clampIndex(from); end = clampIndex(start + count); end<start ⇒ end=start
//     substr(-2)     start=4, end=6  ⇒ "ef"
//     substr(-2,-1)  start=4, end=3  ⇒ end<start ⇒ ""
//     substr(0,-3)   start=0, end=3  ⇒ "abc"
//     substr(1,-100) start=1, end=0  ⇒ end<start ⇒ ""
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }
function eq(actual:String, expected:String, msg:String):void {
  if (actual != expected) {
    throw new Error("FAIL: " + msg + " (got '" + actual + "', want '" + expected + "')");
  }
}

// ---- 1. 真应用的那一行：剥掉秒（":00"）后必须留下完整时间 -------------------
var startAt:String = "2023-02-10 17:50:00";
eq(startAt.substr(0, -3), "2023-02-10 17:50", "negative length counts back from the end (static String receiver)");
eq(startAt.substr(0, startAt.length - 3), "2023-02-10 17:50", "…and agrees with the explicit length-3 form");

// ---- 2. 动态接收者（`*`/Object 字段）走另一条运行时路径，结果必须一致 --------
var dyn:Object = { s: "2023-02-10 17:50:00" };
eq(dyn.s.substr(0, -3), "2023-02-10 17:50", "dynamic receiver resolves substr through the same helper");

// ---- 3. 边界：负数 start 从尾部回算，负数 end 也回算，越界就夹 -----------------
var s:String = "abcdef";
eq(s.substr(2, 2), "cd", "ordinary positive start/length");
eq(s.substr(-2), "ef", "negative start without a count runs to the end");
eq(s.substr(-2, 1), "e", "negative start + positive count");
eq(s.substr(-2, -1), "", "end before start collapses to an empty string");
eq(s.substr(0, 0), "", "zero count is empty");
eq(s.substr(0, -3), "abc", "negative count shorts the tail");
eq(s.substr(1, -100), "", "a wildly negative count clamps under the start");
eq(s.substr(-100, 2), "ab", "a wildly negative start clamps to 0");
eq(s.substr(10), "", "start past the end is empty");
eq(s.substr(2, 100), "cdef", "count past the end is truncated");

// ---- 4. slice 的负数语义本来就是对的那一套，不能被这次改动带偏 --------------
eq(s.slice(0, -3), "abc", "slice(0,-3) still drops the tail");
eq(s.slice(-2), "ef", "slice(-2) still takes the tail");
eq(s.substring(0, -3), "", "substring treats -3 as 0 (unchanged ES3 behavior)");

check(startAt.substr(0, -3).length == 16, "the trimmed stamp keeps 16 characters");
trace("string-substr: ok");