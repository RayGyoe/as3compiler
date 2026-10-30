// reflection-name.as — 阶段三百三十四：反射名的数值口径 + Dictionary + Vector 元素名。
//
// 全部期望值来自 `adl 51.4.1` 实测（证据台 temp/qcn/：Main.as/Main2.as/Main4.as/
// Main5.as/Main6.as/Main7.as 走 adl，逐行输出在 ~/Documents/qcn-out*.txt）。
//
// 三个口径要点：
//  ① 数值的反射名是**值域**判定，不是静态类型：AIR 里 int 与 Number 在 `*` 位上是同一个
//     double，`getQualifiedClassName` 于是按值回答 —— 整数值落在 [-2^28, 2^28-1] 给 "int"，
//     其余给 "Number"。窗口是 2^28 而不是 2^31：AVM2 的 int 原子用 3 个低位做 tag（32 位字），
//     所以 268435455 是 int、268435456 是 Number、2147483647 也是 Number。`uint` 永不出现
//     （`uint(5)` 给 int、`uint.MAX_VALUE` 给 Number），尽管 `5 is uint` 是 true。
//  ② 负零是窗口内唯一的例外：`-0.0` 给 "Number"、`+0.0` 给 "int"。
//  ③ Dictionary 是 C 侧的特殊 kind，但 AIR 报 `flash.utils::Dictionary`（父类仍是 Object）；
//     `Vector.<接口>` 的元素名带包限定名（`flash.events::IEventDispatcher`），与类元素同口径。
import flash.utils.getQualifiedClassName;
import flash.utils.getQualifiedSuperclassName;
import flash.utils.Dictionary;
import flash.events.IEventDispatcher;
import flash.display.Sprite;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

// ---- 1. 值域窗口：整数值 -> int，其余 -> Number -----------------------------
// adl: "1 literal 5 => int" "2 literal 5.5 => Number" "15 literal -5 => int"
check(getQualifiedClassName(5) == "int", "a small integral value is an int");
check(getQualifiedClassName(-5) == "int", "a negative integral value is an int");
check(getQualifiedClassName(5.5) == "Number", "a fractional value is a Number");
check(getQualifiedClassName(NaN) == "Number", "NaN is a Number");
// adl: "E2 2^28-1 => int" "E1 2^28 => Number" "E3 -2^28 => int" "E4 -2^28-1 => Number"
check(getQualifiedClassName(268435455) == "int", "2^28-1 is still an int");
check(getQualifiedClassName(268435456) == "Number", "2^28 is a Number");
check(getQualifiedClassName(-268435456) == "int", "-2^28 is still an int");
check(getQualifiedClassName(-268435457) == "Number", "-2^28-1 is a Number");
// adl: "17 literal int.max => Number" "18 literal 3000000000 => Number" "19 4294967296 => Number"
check(getQualifiedClassName(2147483647) == "Number", "int32 max is OUTSIDE the 2^28 window");
check(getQualifiedClassName(3000000000) == "Number", "a uint-range literal is a Number here");
check(getQualifiedClassName(4294967296) == "Number", "2^32 is a Number");

// ---- 2. 静态类型不参与判定（int / Number / uint 变量同一口径） ---------------
// adl: "4 var int 5 => int" "5 var Number 5 => int" "6 var uint 5 => int"
var iv:int = 5;
var nv:Number = 5;
var uv:uint = 5;
check(getQualifiedClassName(iv) == "int", "an int variable answers int");
check(getQualifiedClassName(nv) == "int", "a Number variable holding 5 answers int");
check(getQualifiedClassName(uv) == "int", "a uint variable holding 5 answers int");
// adl: "E7 int var 2^28 => Number" "E8 Number var 2^28-1 => int"
var ivBig:int = 268435456;
var nvSmall:Number = 268435455;
check(getQualifiedClassName(ivBig) == "Number", "an int variable above the window answers Number");
check(getQualifiedClassName(nvSmall) == "int", "a Number variable inside the window answers int");
// adl: "R1 sqrt(25) => int" "R3 sqrt(2.5) => Number" "R28 Date.time 0 => int"
check(getQualifiedClassName(Math.sqrt(25)) == "int", "a computed double 5.0 answers int");
check(getQualifiedClassName(Math.sqrt(2.5)) == "Number", "a computed fractional double answers Number");
// adl: "11 arr[2] => Number" "11 arr[3] => Number" "11 arr[4] => int"
var arr:Array = [5, 5.5, 3000000000, 4294967296, -5];
check(getQualifiedClassName(arr[0]) == "int", "an array slot holding 5 answers int");
check(getQualifiedClassName(arr[2]) == "Number", "an array slot holding 3000000000 answers Number");
check(getQualifiedClassName(arr[4]) == "int", "an array slot holding -5 answers int");
// adl: "29 dyn prop 5 => int" "24 field int 5 => int"
var dyn:* = {};
dyn.x = 5;
check(getQualifiedClassName(dyn.x) == "int", "a dynamic property holding 5 answers int");

// ---- 3. 负零：窗口内唯一的例外 ---------------------------------------------
// adl: "D3 zero = int neg0 = Number" "Z3 var -0.0 => Number" "Z4 z+0 => int" "Z5 z*1 => Number"
var negZero:Number = -0.0;
check(getQualifiedClassName(negZero) == "Number", "negative zero is a Number");
check(getQualifiedClassName(negZero + 0) == "int", "-0 + 0 is +0, an int");
check(getQualifiedClassName(negZero * 1) == "Number", "-0 * 1 stays -0, a Number");
check(1 / negZero < 0, "the value really is negative zero");
check(getQualifiedClassName(0) == "int", "positive zero is an int");

// ---- 4. Dictionary 的反射名（C 侧 kind，AS3 名字照报） ----------------------
// adl: "D1 dict qcn = flash.utils::Dictionary" "D2 dict qscn = Object"
var dict:Dictionary = new Dictionary();
check(getQualifiedClassName(dict) == "flash.utils::Dictionary", "a Dictionary reports its AS3 name");
check(getQualifiedSuperclassName(dict) == "Object", "a Dictionary extends Object");

// ---- 5. Vector 的元素名：接口元素带包限定名 ---------------------------------
// adl (temp/qcn/Main12): "__AS3__.vec::Vector.<flash.events::IEventDispatcher>",
// super "__AS3__.vec::Vector.<*>"（引用元素型）。
var vi:Vector.<IEventDispatcher> = new Vector.<IEventDispatcher>();
check(getQualifiedClassName(vi) == "__AS3__.vec::Vector.<flash.events::IEventDispatcher>",
	"an interface element is spelled with its package, got " + getQualifiedClassName(vi));
check(getQualifiedSuperclassName(vi) == "__AS3__.vec::Vector.<*>", "a reference-element Vector extends Vector.<*>");
var vs:Vector.<String> = new Vector.<String>();
check(getQualifiedClassName(vs) == "__AS3__.vec::Vector.<String>", "a top-level class element keeps its short name");
var vp:Vector.<Sprite> = new Vector.<Sprite>();
check(getQualifiedClassName(vp) == "__AS3__.vec::Vector.<flash.display::Sprite>",
	"a packaged class element keeps its package, got " + getQualifiedClassName(vp));
var vn:Vector.<int> = new Vector.<int>();
check(getQualifiedClassName(vn) == "__AS3__.vec::Vector.<int>", "a numeric element stays short");
check(getQualifiedSuperclassName(vn) == "Object", "a numeric-element Vector extends Object");