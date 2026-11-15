// short-circuit-guard.as — G47：短路的 `&&`/`||` 不得**急切**求值其操作数。
//
// 修复（阶段四百三十三）：`emit.ts` 的 `sequenceValueExpr` 把短路逻辑运算的 impure
// 左操作数提升为前导 `_sc` 临时变量时，`!isPureExpr(left)` 这一支落在 `guaranteed`
// 门**外**，于是即便整个逻辑表达式处于被短路跳过的分支（guaranteed=false），其左
// 操作数仍被急切求值。库里的焦点守卫
//   `if (n != null && (n.inert() || !n.visible || n.app != this)) return;`
// 在 n=null 时因此对空 n 调了 n.inert()（as_req_obj -> Error #1009）。把该提升
// gating 到 `guaranteed` 即根治；bool 守卫走 emitBinary 的 C `&&`/`||` 快路径，
// 每个操作数仍只求值一次。本示例钉住「跳过分支的 impure 操作数绝不运行」。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Node {
  public var visible:Boolean = true;
  public var inertCalls:int = 0;
  public function inert():Boolean { this.inertCalls++; return false; }
}

// 1) null 守卫 + 复合 || 右侧：不得抛错，结果为 false。
var n:Node = null;
var r1:Boolean = (n != null && (n.inert() || !n.visible));
check(r1 === false, "null guard with a compound || RHS is false (got " + r1 + ")");

// 2) 被跳过分支里的 impure 操作数**绝不能**运行（修复前会急切求值 -> inertCalls=1）。
var probe:Node = new Node();
var guard:Node = null;
var r2:Boolean = (guard != null && (probe.inert() || !probe.visible));
check(r2 === false, "the skipped branch yields false");
check(probe.inertCalls == 0, "an impure operand in a skipped branch must not run (got " + probe.inertCalls + ")");

// 3) 非 null：复合右侧正常求值，impure 操作数恰好运行一次。
var live:Node = new Node();
var r3:Boolean = (live != null && (live.inert() || !live.visible));
check(r3 === false, "live node: inert()=false, visible=true -> false (got " + r3 + ")");
check(live.inertCalls == 1, "the impure operand runs exactly once when reached (got " + live.inertCalls + ")");

// 4) || 短路：真左操作数跳过 impure 右操作数。
var p2:Node = new Node();
var r4:Boolean = (true || p2.inert());
check(r4 === true, "|| with a truthy left is true");
check(p2.inertCalls == 0, "|| skips the impure right after a truthy left (got " + p2.inertCalls + ")");

// 5) 三项复合守卫——focusNode 的精确形状，null 时整条右侧跳过。
var f:Node = null;
var r5:Boolean = (f != null && (f.inert() || !f.visible || f.inertCalls != 0));
check(r5 === false, "the three-term focusNode guard is false on null (got " + r5 + ")");

// 6) 值语义保留：对象 || 默认值仍按同一性透传（非 bool _general 路径不回归）。
var obj:Object = { tag: "T" };
var def:Object = { tag: "D" };
var r6:* = (obj || def);
check(r6 === obj, "value-logical || still passes the object through by identity");
var nullObj:Object = null;
var r7:* = (nullObj || def);
check(r7 === def, "value-logical || falls back to the default on null");

// 7) 非保证上下文里的 impure 左操作数也只求值一次（嵌套短路）。
var once:Node = new Node();
var outer:Node = null;
var r8:Boolean = (outer != null && (once.inert() || true));
check(r8 === false, "nested skipped guard is false");
check(once.inertCalls == 0, "a nested skipped impure left must not run (got " + once.inertCalls + ")");

trace("short-circuit-guard: all assertions passed");