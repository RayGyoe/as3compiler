// object-truthy.as — `Boolean(x)` 作用在**静态声明为 Object** 的槽位上（阶段二百四十八 · G9）
//
// 我们的 Object 槽会把标量**装箱**（as_number_new / as_string_new / as_boolean_new），
// 所以槽里的 `false` / `0` / `NaN` / `""` 都是一个**非 NULL 对象指针**。`Boolean(v)`
// 的降级入口原先对 `isRefType(Object)` 一律做指针非空测试，于是这四类值全被判成 true。
//
// AIR 的行为（adl 51.4.1 实测，asaotui/probes/g9-adl/ 26 格 A/B）：槽里仍是原始标量，
// ToBoolean 按 AS3 规则判定 ⇒ 这七格全部 false。同一个值的其他读法两边逐字相同
// （typeof / String / is / == / Number），连 `if (o)` 都正确 —— 缺陷只在 `Boolean()`
// 这一个入口。
//
// 修复：`Boolean(Object 根)` 先 as_obj_to_value 解箱，再走 as_v_truthy，与 condExpr
// （if/while/?:/!/&&/||）同一条规则。**具体子类**（Sprite/Array/自定义类）槽里永远
// 不会装标量，仍保留指针测试。
//
// 断言直接 throw：改坏任何一格，进程以非 0 退出，示例套件当场红。

function check(name:String, got:*, want:*):void {
  if (String(got) != String(want)) {
    throw new Error("object-truthy: " + name + " got " + got + " want " + want);
  }
}

// 通过 `*` 返回类型给出 false —— 这正是 UI kit 里 `Binding.get():*` 的形状。
function getFalse():* { return false; }

// ---- A) 静态 Object 槽装原始标量：全部假值 ----
var o:Object = getFalse();
check("Boolean(Object<false>)", Boolean(o), false);
check("typeof(Object<false>)", typeof(o), "boolean");   // 箱信息没丢
check("String(Object<false>)", String(o), "false");

var z:Object = 0;
check("Boolean(Object<0>)", Boolean(z), false);

var e:Object = "";
check("Boolean(Object<\"\">)", Boolean(e), false);

var nan:Object = Math.sqrt(-1);
check("Boolean(Object<NaN>)", Boolean(nan), false);

var bb:Boolean = false;
var ob:Object = bb;
check("Boolean(Object<Boolean false>)", Boolean(ob), false);

// 动态属性读进 Object 槽（等价于 kit 的 `Binding.get()` 返回 false）
var holder:Object = {};
holder.flag = false;
var p:Object = holder.flag;
check("Boolean(Object<dyn false>)", Boolean(p), false);

// 包装器：AVM2 对 Boolean 包装器透明（AIR 实测 typeof=boolean、Boolean=false），
// 不是 ES3 的 object/true。
var w:Object = new Boolean(false);
check("Boolean(new Boolean(false))", Boolean(w), false);
check("typeof(new Boolean(false))", typeof(w), "boolean");

// ---- B) 真值格：修复不得反向把真值判假 ----
var t:Object = "x";
check("Boolean(Object<\"x\">)", Boolean(t), true);
var five:Object = 5;
check("Boolean(Object<5>)", Boolean(five), true);
var arr:Object = [1, 2];
check("Boolean(Object<Array>)", Boolean(arr), true);
var plain:Object = {};
check("Boolean(Object<{}>)", Boolean(plain), true);
var fn:Object = getFalse;
check("Boolean(Object<Function>)", Boolean(fn), true);

// ---- C) 空槽 ----
var nu:Object = null;
check("Boolean(Object<null>)", Boolean(nu), false);

// ---- D) 与 condExpr 同口径：if 分支本来就对，修复后不得分叉 ----
var taken:Boolean = false;
if (o) taken = true;
check("if (Object<false>) skipped", taken, false);
check("!Object<false>", !o, true);
check("?: on Object<false>", (o ? "T" : "F"), "F");

trace("object-truthy: all assertions passed");