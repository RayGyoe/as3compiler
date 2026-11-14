// dynamic-inc.as — 动态（`*`）槽上的 `++`/`--`，以及动态 `const` 的初始化顺序。
//
// 两处修复（阶段四百一十六）：
//  1) `var x:* = 0; x++;` 此前**根本编译不过**：发射器把目标当 C 左值，直接写
//     `(g_x++)`，clang 报 `cannot increment value of type 'as_value'`。AS3 允许
//     对无类型槽做自增（ES3 §11.3.1/§11.4.1：读写都过 ToNumber），所以这是一条
//     语义缺口而不是不支持的特性。现在展开为 `x = as_v_num(Number(x) ± 1)`，
//     后缀式的值取 **ToNumber(旧值)**（不是原始旧值——`"5"++` 得 5 而非 "5"），
//     槽本身变成 Number。
//  2) `const N:* = 5;` 同样编译不过：发射器给了它 `static const as_value g_N =
//     as_v_num(5);`，而 C 的 static 初始化器必须是编译期常量（`as_v_num` 是调用）。
//     现在 `*` 槽一律按「运行期初始化」处理：声明给出默认值（undefined），初始化
//     表达式在 main() 里按源码顺序执行一次——与 `static const d = new Dictionary()`
//     既有的处理方式一致。`int`/`Number`/`String` 字面量仍是真正的 C 静态常量。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 9) 顶层动态 const（字面量初始化在 main() 里跑一次），以及类静态 const。
const MOD_N:* = 5;
const MOD_S:* = "hi";
const MOD_NUM:Number = 2.5;
class Holder {
  public static const TAG:* = "tag";
  public static const ID:int = 7;
}
check(MOD_N == 5, "a module-level `const x:*` literal is initialised before use (got " + MOD_N + ")");
check(MOD_S == "hi", "a module-level dynamic String const is initialised (got " + MOD_S + ")");
check(MOD_NUM == 2.5, "a module-level Number const stays a compile-time static (got " + MOD_NUM + ")");
check(Holder.TAG == "tag", "a class static `const x:*` is initialised once (got " + Holder.TAG + ")");
check(Holder.ID == 7, "a class static int const is unchanged (got " + Holder.ID + ")");

// 1) 语句位置：值被丢弃，只留读-改-写。
var a:* = 0;
a++;
check(a == 1, "statement-position `a++` on a dynamic slot increments (got " + a + ")");

// 2) 后缀式的值是旧值（ToNumber 之后）。
var b:* = 10;
var b0:* = b++;
check(b0 == 10, "postfix yields the pre-increment value (got " + b0 + ")");
check(b == 11, "...and the slot is incremented (got " + b + ")");

// 3) 前缀式的值是新值。
var c:* = 10;
var c0:* = ++c;
check(c0 == 11, "prefix yields the new value (got " + c0 + ")");
check(c == 11, "...and the slot matches it (got " + c + ")");

// 4) 递减两侧。
var d:* = 5;
check(d-- == 5 && d == 4, "postfix `--` (got " + d + ")");
var e:* = 5;
check(--e == 4 && e == 4, "prefix `--` (got " + e + ")");

// 5) 槽里是字符串时按 ToNumber 处理：`"5"++` 得 5，槽变成 6（不是 "51" 也不是 "6"）。
var s:* = "5";
var s0:* = s++;
check(s0 == 5, "postfix on a numeric String yields a Number (got '" + s0 + "')");
check(s == 6, "...and stores the incremented Number (got '" + s + "')");
check(typeof s == "number", "the slot holds a Number afterwards (got " + typeof s + ")");

// 6) 槽里是非数字字符串时得 NaN（ES3 的 ToNumber 语义），不得抛异常。
var t:* = "abc";
t++;
check(isNaN(t), "incrementing a non-numeric String yields NaN (got " + t + ")");

// 7) for 的更新子句（值被丢弃的位置）也要展开成读-改-写，不能留下未使用的临时变量。
var sum:Number = 0;
for (var i:* = 0; i < 4; i++) sum += i;
check(sum == 6, "a dynamic counter drives a for loop (got " + sum + ")");

// 8) 数组元素上的自增走的仍是容器通路（元素通过运行期访问器读写），一并复核。
var arr:Array = [1];
arr[0]++;
check(arr[0] == 2, "`a[i]++` on a dynamic element still increments (got " + arr[0] + ")");

// 9) 三目 `?:` 与 `&&`/`||` 同一条红线：结果取**被选中那一侧的值**，绝不按另一侧的
//    静态类型强转。以前 `unifyType(any, int)` 取 int，`convert` 再把 `any` 侧 unbox 成
//    int —— 0.974 静默截断成 0（`true ? 0 : "x"` 则把 0 串成 "0"）。这是本轮转译器
//    对首个真文件做 A/B 时暴露出来的（`js/vehicle-physics.js` 的 contact.x 全变 0）。
function pickNum(v:*):* { return v == null ? 0 : v; }
check(pickNum(0.974) == 0.974, "a dynamic arm beside an int arm keeps its fraction (got " + pickNum(0.974) + ")");
check(pickNum(null) == 0, "the int arm still answers 0 for null");
var narrowed:* = (true ? 0 : "x");
check(typeof narrowed == "number" && narrowed == 0, "`true ? 0 : \"x\"` does not stringify 0 (got " + typeof narrowed + " " + narrowed + ")");
var strArm:* = (false ? 0 : "x");
check(typeof strArm == "string" && strArm == "x", "the String arm still answers the string");
check((false ? 7 : 8.5) == 8.5, "int/Number arms still promote to double");

trace("dynamic-inc: all assertions passed");