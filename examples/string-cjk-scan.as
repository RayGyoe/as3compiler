// string-cjk-scan.as — **非 ASCII** 串上的码元翻译（阶段四百四十四）
//
// `string-ascii-scan.as` 钉的是「索引空间塌成恒等」那条快路径；本示例钉的是它的反面：
// 码元数**必须真的数出来**时，`indexOf` / `lastIndexOf` / `charAt` / `substring` 仍然
// 必须返回**码元索引**（不是字节偏移），而且不能因为「要数」就退化成每调用一次走整串。
//
// 修复前的形状（`as_str_lastIndexOf_from` 的非 ASCII 分支）：从字节 0 **正向走完整串**，
// 无论命中就在 `from` 旁边。在 4000 行中文（176000 码元 / 516000 字节）上，8000 次
// `lastIndexOf` 要 3.7 s；改成「反向扫字节 + 跳过续字节 ⇒ 只在命中处翻译一次」后是 0 ms
// （temp/cjk/probe_cjk.as 的四相位读数）。
//
// 期望值全部按**码元**手算并与 `adl 51.4.1` 逐条核对（temp/cjk/air/，同源探针）。
//
// 覆盖到的边界：
//   · 大 CJK 串（每行 43 字 + "\n" = 44 码元 / 130 字节）：索引必须与字节偏移分道扬镳
//   · 从大往小的 `from` 扫描（这正是旧实现退化的形状），逐值对齐而不只是首尾
//   · CJK 针 / 跨字符边界的针 / 不存在的中文针
//   · 空针、负 from、from 超过长度、from 落在行边界上
//   · 尾部拼上 ASCII 之后整串不再是纯 ASCII：非 ASCII 分支里也要能找到 ASCII 针
//   · 随机访问 charAt / charCodeAt / substring 仍按码元走

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 43 个汉字 + "\n"：44 码元、130 字节。码元偏移与字节偏移从第 2 个字起就不同。
var line:String = "敏捷的棕色狐狸跳过了那只懒狗用它来测试中日韩文字的码元索引和字节偏移之间的翻译开销六字";
var big:String = "";
for (var k:int = 0; k < 4000; k++) { big += line + "\n"; }

// ---------------------------------------------------------- 1) 规模与索引空间
check(line.length == 43, "CJK line is 43 code units");
check(big.length == 176000, "big CJK length is code units (4000 x 44), not bytes");
// 狐狸 在第 5 个码元；它的字节偏移是 15（每个汉字 3 字节）。返回 5 才说明是码元索引。
check(big.indexOf("狐狸") == 5, "CJK indexOf returns the CODE UNIT index, not the byte offset");
check(big.charAt(5) == "狐", "CJK charAt at the code-unit index");
check(big.charCodeAt(5) == 29392, "CJK charCodeAt decodes the code point");
check(big.charCodeAt(43) == 10, "the line separator sits at unit 43");

// ---------------------------------------------------------- 2) lastIndexOf：大串 + 从大往小
var base:int = 44 * 3999;                       // 最后一行的起点（码元）
check(big.lastIndexOf("狐狸") == base + 5, "lastIndexOf with no from takes the last line");
check(big.lastIndexOf("狐狸", base + 5) == base + 5, "start == from is allowed");
check(big.lastIndexOf("狐狸", base + 4) == base - 44 + 5, "from cuts the last occurrence off");
check(big.lastIndexOf("的") == base + 36, "single CJK character");
check(big.lastIndexOf("六字") == base + 41, "two CJK characters at the line tail");
check(big.lastIndexOf("不存在") == -1, "missing CJK needle");
check(big.lastIndexOf("狗用它") == base + 13, "needle spanning three characters");
check(big.lastIndexOf("") == 176000, "empty needle matches at the clamped from (= length)");
check(big.lastIndexOf("", 100) == 100, "empty needle honours from");
check(big.lastIndexOf("狐狸", -1) == -1, "negative from is -1, NOT clamped to 0");
check(big.lastIndexOf("狐狸", 1000000) == base + 5, "from beyond the length is clamped");

// 逐值扫描：旧实现每调一次走整串，这里 200 个相邻 from 都要精确（不是首尾对上就算过）
var want:int = base + 5;
var sweepOK:Boolean = true;
for (var f:int = 176000; f > 175800; f--) {
  while (f < want) want -= 44;                  // 每退过一行，答案就前移一行
  if (big.lastIndexOf("狐狸", f) != want) sweepOK = false;
}
check(sweepOK, "descending from sweep stays exact across a line boundary");

// ---------------------------------------------------------- 3) 混入 ASCII 尾：整串不再是纯 ASCII
var mixed:String = big + "fox jumped";
check(mixed.length == 176000 + 10, "mixed length in code units");
check(mixed.lastIndexOf("狐狸") == base + 5, "CJK needle still found after an ASCII tail");
check(mixed.lastIndexOf("fox") == 176000, "ASCII needle on a CJK string (non-ASCII path)");
check(mixed.lastIndexOf("jumped") == 176004, "ASCII needle near the end");
check(mixed.indexOf("fox") == 176000, "indexOf from the CJK prefix");
check(mixed.lastIndexOf("x") == 176002, "single ASCII character after a CJK prefix");
check(mixed.lastIndexOf("敏") == 44 * 3999, "CJK needle at a line start");

// ---------------------------------------------------------- 4) 随机访问仍按码元
check(big.substring(175956, 176000) == line + "\n", "substring of the last line, separator included");
check(big.substring(175956, 175999) == line, "substring stops before the separator");
check(big.substring(175999, 176000) == "\n", "single code unit at the very end");
check(big.substring(base + 5, base + 7) == "狐狸", "substring by code-unit indices");
check(big.substring(0, 2) == "敏捷", "substring from the head");
check(big.substring(base + 43, base + 44) == "\n", "substring of the separator");

trace("string-cjk-scan: OK");