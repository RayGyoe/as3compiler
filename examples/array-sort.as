// array-sort.as — Array.sort / sortOn option bits, UNIQUESORT/RETURNINDEXEDARRAY
// return shapes, NUMERIC validation, and sparse-slot compaction.
//
// Every expectation below is an `adl 51.4.1` reading (temp/sortprobe/). Two
// places deliberately do NOT copy AIR:
//   1. tie order. AIR's qsort permutes equal keys (with CASEINSENSITIVE the two
//      "a"s and the "A" come back in a different order on almost every run), so
//      this build keeps a stable merge and asserts the stable order.
//   2. which element a NUMERIC #1034 names. AIR converts lazily inside its
//      comparison loop, so ["a","B"] reports "B"; we validate in array order and
//      report "a". The error id and the message shape are identical.
function check(condition:Boolean, label:String):void {
  if (!condition) throw new Error("array-sort: " + label);
}

function copyOf(source:Array):Array {
  var out:Array = [];
  for (var i:int = 0; i < source.length; i++) out.push(source[i]);
  return out;
}

var seed:Array = ["a", "B", "b", "A", "10", "9", "c", "", "a"];

// ---- 位标志：以前五种组合的输出与 sort() 逐字相同 ----
var plain:Array = copyOf(seed);
plain.sort();
check(plain.join(",") == ",10,9,A,B,a,a,b,c", "default is a case-sensitive string sort");

var ci:Array = copyOf(seed);
ci.sort(Array.CASEINSENSITIVE);
check(ci.join(",") == ",10,9,a,A,a,B,b,c", "CASEINSENSITIVE folds ASCII case");

var desc:Array = copyOf(seed);
desc.sort(Array.DESCENDING);
check(desc.join(",") == "c,b,a,a,B,A,9,10,", "DESCENDING reverses the comparison");

var ciDesc:Array = copyOf(seed);
ciDesc.sort(Array.CASEINSENSITIVE | Array.DESCENDING);
check(ciDesc.join(",").toLowerCase() == "c,b,b,a,a,a,9,10,", "CASEINSENSITIVE|DESCENDING combines");

var unknownBit:Array = copyOf(seed);
unknownBit.sort(32);
check(unknownBit.join(",") == plain.join(","), "bit 32 is a no-op");

// ---- NUMERIC ----
var numbers:Array = ["10", "9", "1", "100", "-3", "0.5", "2", "-0.5"];
numbers.sort(Array.NUMERIC);
check(numbers.join(",") == "-3,-0.5,0.5,1,2,9,10,100", "NUMERIC compares as numbers");

var numbersDesc:Array = ["10", "9", "1", "100", "-3", "0.5", "2", "-0.5"];
numbersDesc.sort(Array.NUMERIC | Array.DESCENDING);
check(numbersDesc.join(",") == "100,10,9,2,1,0.5,-0.5,-3", "NUMERIC|DESCENDING");

// NaN 排在所有数值之后（adl: [NaN,1].sort(NUMERIC) 得 1,NaN）
var withNaN:Array = [NaN, 1];
withNaN.sort(Array.NUMERIC);
check(withNaN[0] === 1 && isNaN(withNaN[1] as Number), "NUMERIC puts NaN last");

// 转不成数值的值抛 #1034（Number/Boolean/null/可解析字符串都合法）
var badNumeric:Array = ["a", "B"];
try {
  badNumeric.sort(Array.NUMERIC);
  check(false, "NUMERIC must reject a non-numeric element");
} catch (error:TypeError) {
  check(error.errorID == 1034, "NUMERIC raises #1034");
  check(error.message.indexOf("to Number.") > 0, "NUMERIC message names Number");
}

var lenient:Array = [{ k: "a" }, { k: "B" }, { k: "10" }, { k: "9" }];
lenient.sortOn("k", Array.NUMERIC);
check(lenient[0].k == "9" && lenient[1].k == "10", "sortOn does NOT raise on non-numeric keys");

// ---- UNIQUESORT：重复 ⇒ 返回 Number 0，数组一个字节都不动 ----
var dup:Array = copyOf(seed);
var dupResult:* = dup.sort(Array.UNIQUESORT);
check(dupResult === 0, "UNIQUESORT returns Number 0 on a duplicate");
check(dup.join(",") == seed.join(","), "UNIQUESORT leaves the array untouched");

var uniqueArr:Array = ["c", "a", "b"];
check(uniqueArr.sort(Array.UNIQUESORT) == uniqueArr, "UNIQUESORT returns the array when unique");
check(uniqueArr.join(",") == "a,b,c", "UNIQUESORT still sorts");

var uniqueOnDup:Array = [{ k: "a" }, { k: "a" }, { k: "b" }];
check(uniqueOnDup.sortOn("k", Array.UNIQUESORT) === 0, "sortOn UNIQUESORT returns 0 on a duplicate");

var typedArrayDup:Array = ["a", "a"];
try {
  var asTyped:Array = typedArrayDup.sort(Array.UNIQUESORT);
  check(false, "the Number 0 must fail an Array-typed assignment");
} catch (error2:TypeError) {
  check(error2.errorID == 1034, "typed assignment of the 0 raises #1034");
}

// ---- RETURNINDEXEDARRAY：只给下标表，原数组不动 ----
var indexed:Array = ["a", "B", "b", "A", "10", "9", "c", "", "a"];
var order:* = indexed.sort(Array.RETURNINDEXEDARRAY);
check(order.join(",") == "7,4,5,3,1,0,8,2,6", "RETURNINDEXEDARRAY reports sorted indices");
check(indexed.join(",") == seed.join(","), "RETURNINDEXEDARRAY leaves the array untouched");

var indexedDesc:Array = copyOf(seed);
var orderDesc:* = indexedDesc.sort(Array.RETURNINDEXEDARRAY | Array.DESCENDING);
check(orderDesc.join(",").split(",")[0] == "6", "indexed respects DESCENDING");

// ---- 稀疏槽：排完压实到前部，尾部一律是洞 ----
var sparse:Array = [5, 4, 3];
sparse[10] = 1;
check(sparse.length == 11 && !(4 in sparse), "index-jump write leaves holes, not nulls");
sparse.sort();
check(sparse.length == 11, "sort preserves the length");
check(sparse.join(",") == "1,3,4,5,,,,,,,", "sort compacts the defined elements");
check(!(4 in sparse) && !(10 in sparse), "the tail becomes holes");
check(sparse[4] === undefined, "a hole reads back as undefined");

var sparseDesc:Array = [5, 4, 3];
sparseDesc[10] = 1;
sparseDesc.sort(Array.DESCENDING);
check(sparseDesc.join(",") == "5,4,3,1,,,,,,,", "descending compaction");

// 一个洞不算重复，两个洞才算（adl 实测）
var oneHole:Array = ["b", "a"];
oneHole[3] = "c";
check(oneHole.sort(Array.UNIQUESORT) == oneHole, "a single hole is not a duplicate");
var twoHoles:Array = ["b", "a"];
twoHoles[4] = "c";
check(twoHoles.sort(Array.UNIQUESORT) === 0, "two holes count as a duplicate");

// 稀疏数组的 RETURNINDEXEDARRAY：已定义下标在前、洞的下标按升序在后
var sparseIndexed:Array = [5, 4, 3];
sparseIndexed[10] = 1;
var sparseOrder:* = sparseIndexed.sort(Array.RETURNINDEXEDARRAY);
check(sparseOrder.join(",") == "10,2,1,0,3,4,5,6,7,8,9", "indexed puts hole indices last");

// ---- sort(compareFunction) 仍是比较器形态 ----
var custom:Array = [3, 1, 2];
custom.sort(function (x:Number, y:Number):Number { return y - x; });
check(custom.join(",") == "3,2,1", "a Function argument still means comparator");

trace("array-sort: OK");