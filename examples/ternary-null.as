// ternary-null.as — `cond ? null : X` 必须返回 X（阶段二百六十六 · G16）
//
// AS3 的条件运算符按**条件**选一支，null 字面量只是一个**值**（语言参考，
// conditional operator）。旧实现在「THEN 槽是 null 字面量」时把整个三元表达式
// 的静态类型定成 `null`（`unifyType` 的 `return a` 兜底），`convert` 于是把结果
// 发射成常量 —— 对象→`NULL`、`Number`→`0.0`、`Boolean`→`false`、`int`→`0`，
// **真正会跑的那一支被整段丢掉**。`String` 唯一免疫（`unifyType` 的 string 规则
// 排在兜底之前）。
//
// 修法（`unifyType` 加一条族规则，排在 `any` 规则**之前**）：
//   * 另一侧是**指针族**（object/Array/Dictionary/Vector/XML/Function/Class/…）⇒
//     保留该具体类型：这些类型的 null 就是 `NULL`，两个方向都对；
//   * 另一侧是**数值/布尔/`*`** ⇒ 结果定成 `any`（装箱）。double/bool 的 C 表示里
//     没有 null，只保住 ELSE 侧会反过来把 THEN 的 null 折成 0。
//
// 下面每一格的期望值都是 **adl 51.4.1 实测**（`asaotui/probes/g16-ternary-null/`
// 的 20 格双 runtime 矩阵，修后 20/20 逐字一致）。断言直接 throw：改坏任何一格，
// 进程非 0 退出，示例套件当场红。

import flash.display.Bitmap;
import flash.display.BitmapData;

function check(name:String, got:*, want:*):void
{
  if (String(got) != String(want)) {
    throw new Error("ternary-null: " + name + " got " + got + " want " + want);
  }
}

// ---- 被测形状（THEN 槽是 null 字面量）----
function pick(o:Object):Bitmap { return o == null ? null : Bitmap(o); }
function noCast(o:Object):Object { return o == null ? null : o; }
function constFalse():Bitmap { return 1 == 0 ? null : new Bitmap(new BitmapData(4, 6, false, 0x112233)); }
function wrap(o:Object):Bitmap { return Bitmap(o); }
function viaCall(o:Object):Bitmap { return o == null ? null : wrap(o); }
function elem(list:Array, o:Object):Object { return o == null ? null : list[0]; }

// ---- 值类型结果（旧实现静默变 0 / false）----
function numSlot(o:Object):Number { return o == null ? null : 42; }
function boolSlot(o:Object):Boolean { return o == null ? null : true; }
function intSlot(o:Object):int { return o == null ? null : 7; }
function strSlot(o:Object):String { return o == null ? null : String("hi"); }

// ---- 反方向：`x != null` 为真 ⇒ THEN 的 null 才是值 ----
// 返回类型写 `*`：`:Number` 槽会在 return 处把 null 变成 0，看不见答案。
function nullArmNum(o:Object):* { return o != null ? null : 42; }
function nullArmBool(o:Object):* { return o != null ? null : true; }
function nullArmInt(o:Object):* { return o != null ? null : 7; }

// ---- 对照：既有写法不能被这次改动碰坏 ----
function otherWay(o:Object):Bitmap { return o == null ? Bitmap(o) : null; }
function workaround(o:Object):Bitmap { if (o == null) return null; return Bitmap(o); }
function noNullAtAll(o:Object):int { return o == null ? 0 : 42; }

class Holder
{
  public var bm:Object;      // Object 槽：读出来是 `*` 形状
  public var list:Array;
}

var live:Bitmap = new Bitmap(new BitmapData(8, 8, false, 0x22AA55));

// ---- A) 对象型结果：THEN 是 null、条件为假 ⇒ 必须返回 ELSE 的那个对象 ----
check("pick(live) != null", pick(live) != null, true);
check("pick(live).width", pick(live).width, 8);
check("pick(live).height", pick(live).height, 8);
check("pick(null) == null", pick(null) == null, true);
check("noCast(live) is the same object", noCast(live) == live, true);
check("constFalse() != null", constFalse() != null, true);
check("constFalse().width", constFalse().width, 4);
check("constFalse().height", constFalse().height, 6);
check("viaCall(live) != null", viaCall(live) != null, true);
check("viaCall(live).width", viaCall(live).width, 8);

// 成员读 / 数组元素（`*` 槽）：这条旧版返回 NULL
var holder:Holder = new Holder();
holder.bm = live;
holder.list = [live];
check("holder.bm != null", (live == null ? null : holder.bm) != null, true);
check("holder.list[0] width", (live == null ? null : (holder.list[0] as Bitmap)).width, 8);
check("elem([live], live) width", (elem([live], live) as Bitmap).width, 8);

// ---- B) 值类型结果：旧版静默变 0 / false，比 null 更难发现 ----
check("Number slot", numSlot(live), 42);
check("Boolean slot", boolSlot(live), true);
check("int slot", intSlot(live), 7);
check("String slot (was always immune)", strSlot(live), "hi");

// ---- C) 反方向：null 那一支真的会跑，不能被折成 0 / false ----
check("nullArmNum", String(nullArmNum(live)), "null");
check("nullArmBool", String(nullArmBool(live)), "null");
check("nullArmInt", String(nullArmInt(live)), "null");

// ---- D) 对照：这些写法修前修后都必须同样正确 ----
check("otherWay(live) == null", otherWay(live) == null, true);
check("workaround(live) != null", workaround(live) != null, true);
check("workaround(live).width", workaround(live).width, 8);
check("no null literal at all", noNullAtAll(live), 42);

// 装箱后的 `any` 结果参与布尔判断与拼接：5 是真值、拼出来是 "5"
var boxed:* = (live == null ? null : 5);
check("boxed truthy", Boolean(boxed), true);
check("boxed as string", String(boxed), "5");
check("boxed == 5", boxed == 5, true);

trace("ternary-null: all assertions passed");