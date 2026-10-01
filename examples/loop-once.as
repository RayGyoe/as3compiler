// loop-once.as — 循环条件与 `for` 更新每轮只求值一次（阶段八十九·四十三）。
//
// AS3 规定 `while`/`do-while`/`for` 的条件（以及 `for` 的 update）**每轮求值一次**。
// 生成 C 的形态会把条件里的同一操作数内联多处：
//   * getter 读 `p->vtable->get_n(p->vtable->get(p))`（接收者两次）
//   * setter 写 `p->vtable->get(p)->vtable->set_n(p->vtable->get(p), v)`（接收者两次）
//   * setter 自增 `p->vtable->get(p)->set_n(get(p), get(p)->get_n(get(p)) + 1)`（四次）
// 条件里带副作用的调用（`p.get()`、`src.fetch()`）就会被求值两次/四次——可观测的语义
// 差异（AIR 只求值一次）。更隐蔽的是：`for` 的 update 若被内联多次，副作用也翻倍。
//
// 本例用静态计数器统计「条件测试里被调了几次」，逐条与「每轮一次」对照；
// 另有一组专门验证修复不破坏既有语义：`continue` 必须仍能到达 `for` 的 update、
// 条件每轮确实重新求值（不能被提升到循环外冻结）、赋值当条件的值语义、
// 嵌套循环的标签 `continue`/`break`、以及接收者与 RHS 的**从左到右求值顺序**。
//
// 修法见 `emit.ts`：`emitWhile`/`emitDoWhile`/`emitFor` 只在确有需要提升时才把循环
// 改写成 `for (;;) { <前置> if (!(cond)) break; … }`，前置语句放在循环体**内部**
// （放在循环外会冻结副作用）；`Update`/`Assign` 分支在 `resolve*Setter` 之前提升
// 不纯接收者（resolver 会把接收者的 C 文本烘进 `objCode`，之后提升就无效了）。

class Probe {
  public static var calls:int = 0;
  public static var order:String = "";
  private var _n:int = 0;
  public function Probe(n:int) { _n = n; }
  public function get n():int { return _n; }
  public function set n(v:int):void { _n = v; }
  public function get():Probe { calls++; order += "R"; return this; }
  public function val():int { calls++; order += "V"; return _n; }
  public static function fetch():* {
    calls++; order += "f";
    return calls <= 3 ? new Probe(calls) : null;
  }
}

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var p:Probe = new Probe(1);
function reset():void { Probe.calls = 0; }

// ---------- 1) 循环条件 / for 更新：每轮一次 ----------

// while：条件真→假一次翻转，共测两次
reset();
var it:int = 0; p.n = 1;
while (p.get().n > 0) { it++; p.n = 0; }
expect(Probe.calls == 2, "while condition evaluates its subject once per test (got " + Probe.calls + ")");
expect(it == 1, "and the body ran once (got " + it + ")");

// do-while：先跑体，再测条件
reset();
it = 0; p.n = 1;
do { it++; p.n = (it >= 2 ? 0 : 1); } while (p.get().n > 0);
expect(Probe.calls == 2, "do-while condition evaluates its subject once per test (got " + Probe.calls + ")");
expect(it == 2, "and the body ran twice (got " + it + ")");

// for 条件
reset();
it = 0; p.n = 1;
for (var j:int = 0; p.get().n > 0; j++) { it++; p.n = 0; }
expect(Probe.calls == 2, "for condition evaluates its subject once per test (got " + Probe.calls + ")");
expect(it == 1, "and the body ran once (got " + it + ")");

// for 更新：只在体跑完后执行一次，且条件假时不再执行
reset();
p.n = 1;
for (var k:int = 0; p.n > 0; p.get().n = 0) { }
expect(Probe.calls == 1, "for update evaluates its subject once (got " + Probe.calls + ")");

// 条件每轮真的重新求值（前置语句必须在循环体内，不能提到循环外冻结）
reset();
var rounds:int = 0; p.n = 2;
while (p.get().val() > 0) { rounds++; p.n = p.n - 1; }
expect(rounds == 2, "an impure condition is re-evaluated every round (got " + rounds + ")");
expect(Probe.calls == 6, "two calls per test x three tests (got " + Probe.calls + ")");

// ---------- 2) `continue` 仍须到达 for 的 update ----------

var s:int = 0;
for (var i:int = 0; i < 3; i++) { s++; continue; }
expect(s == 3, "unlabelled continue still runs the for update (got " + s + ")");

// 走「改写」路径（条件不纯）的 for + continue
reset();
s = 0; p.n = 0;
for (var q:int = 0; p.get().n < 3; p.n = p.n + 1) { s++; continue; }
expect(s == 3, "continue reaches the update in a sequenced for (got " + s + ")");
expect(Probe.calls == 4, "three true tests + one false (got " + Probe.calls + ")");

s = 0; var w:int = 0;
while (w < 3) { w++; s++; continue; }
expect(s == 3, "continue in a while re-tests the condition (got " + s + ")");

// 走「改写」路径的 do-while + continue：continue 之后必须重新测条件
reset();
s = 0; p.n = 1;
do { s++; p.n = 0; continue; } while (p.get().n > 0);
expect(s == 1, "continue in a sequenced do-while re-tests the condition (got " + s + ")");
expect(Probe.calls == 1, "and the condition ran once (got " + Probe.calls + ")");

s = 0;
for (var a:int = 0; a < 3; a++) { s++; continue; }
expect(s == 3, "unlabelled continue baseline (got " + s + ")");
s = 0;
outer: for (var b:int = 0; b < 3; b++) { s++; continue outer; }
expect(s == 3, "labelled continue jumps to the outer update (got " + s + ")");

// ---------- 3) 接收者只求值一次（setter 写 / 自增） ----------

reset(); p.get().n = 5;
expect(Probe.calls == 1, "a setter write evaluates a getter receiver once (got " + Probe.calls + ")");
expect(p.n == 5, "and still writes (got " + p.n + ")");

reset(); p.get().n += 2;
expect(Probe.calls == 1, "a compound setter write evaluates its receiver once (got " + Probe.calls + ")");
expect(p.n == 7, "and still accumulates (got " + p.n + ")");

reset(); p.get().n++;
expect(Probe.calls == 1, "a setter post-increment evaluates its receiver once (got " + Probe.calls + ")");
expect(p.n == 8, "and still increments (got " + p.n + ")");

reset(); var t:int = p.get().n++;
expect(Probe.calls == 1, "a value-context post-increment evaluates its receiver once (got " + Probe.calls + ")");
expect(t == 8 && p.n == 9, "post-increment yields the old value then stores (got " + t + "/" + p.n + ")");

reset(); var u:int = ++p.get().n;
expect(Probe.calls == 1, "a value-context pre-increment evaluates its receiver once (got " + Probe.calls + ")");
expect(u == 10 && p.n == 10, "pre-increment yields the new value (got " + u + "/" + p.n + ")");

// ---------- 4) 赋值当条件（setter 形态）的值语义 ----------

reset();
var body:int = 0; p.n = 9;
for (var z:int = 0; p.get().n = (z < 2 ? 5 : 0); z++) { body++; }
expect(Probe.calls == 3, "a setter assignment as a loop condition tests its receiver once per round (got " + Probe.calls + ")");
expect(body == 2, "and the body ran while the assigned value was truthy (got " + body + ")");
expect(p.n == 0, "the failing test still performed the write (got " + p.n + ")");

reset();
var body2:int = 0; var y:int = 0; p.n = 9;
while (p.get().n = (y < 1 ? 5 : 0)) { body2++; y++; }
expect(Probe.calls == 2, "the same holds for while (got " + Probe.calls + ")");
expect(body2 == 1 && p.n == 0, "while assignment-condition semantics (got " + body2 + "/" + p.n + ")");

// 赋值当条件的**值**来自 RHS 而非 setter 的 void 返回
reset();
p.n = 1;
if (p.get().n = 4) { } else { throw new Error("FAIL: a setter assignment is truthy by its RHS value"); }
expect(p.n == 4 && Probe.calls == 1, "if (recv.prop = v) stores and tests the RHS (got " + p.n + "/" + Probe.calls + ")");

// ---------- 5) 从左到右求值顺序：接收者先于 RHS ----------

Probe.order = "";
reset();
p.get().n = p.val();
expect(Probe.order == "RV", "a setter write evaluates the receiver before the RHS (got '" + Probe.order + "')");

Probe.order = "";
reset();
if (p.get().n = p.val()) { }
expect(Probe.order == "RV", "the same order holds in condition position (got '" + Probe.order + "')");

Probe.order = "";
reset();
var brk:int = 0;
while (p.get().n = p.val()) { brk++; break; }
expect(Probe.order == "RV", "and in a while condition (got '" + Probe.order + "')");
expect(brk == 1, "the loop body ran once (got " + brk + ")");

// ---------- 6) 赋值当条件的经典写法：读流直到 null ----------

Probe.order = "";
reset();
var cur:* = null;
var got:int = 0;
while ((cur = Probe.fetch()) != null) { got++; }
expect(got == 3, "while ((v = fetch()) != null) consumes until null (got " + got + ")");
expect(Probe.calls == 4, "and fetch ran exactly once per test (got " + Probe.calls + ")");
expect(Probe.order == "ffff", "the assignment re-evaluated each round, not frozen (got '" + Probe.order + "')");

// 同一写法在 for 条件里
reset();
var got2:int = 0;
for (var c:* = Probe.fetch(); c != null; c = Probe.fetch()) { got2++; }
expect(got2 == 3, "the for-condition/update variant consumes until null (got " + got2 + ")");
expect(Probe.calls == 4, "one fetch in the init + three in the update (got " + Probe.calls + ")");

// ---------- 7) 循环形态不因提升而改变 ----------

var once:int = 0;
do { once++; } while (false);
expect(once == 1, "a do-while body always runs at least once (got " + once + ")");

var c2:int = 0;
for (;;) { c2++; if (c2 >= 5) break; }
expect(c2 == 5, "a condition-less for terminates via break (got " + c2 + ")");

c2 = 0;
for (var m:int = 0; ; m++) { if (m >= 4) break; c2++; }
expect(c2 == 4, "a for with no condition still runs its update (got " + c2 + ")");

c2 = 0;
for (var n2:int = 0; ; n2++) { if (n2 >= 3) break; c2++; }
expect(n2 == 3 && c2 == 3, "the for variable survives the rewritten form (got " + n2 + "/" + c2 + ")");

// 多声明符 for（提升后 init 变成循环前的独立语句）
c2 = 0;
for (var x:int = 0, lim:int = 3; x < lim; x++) { c2++; }
expect(c2 == 3, "a multi-declarator for init still runs once (got " + c2 + ")");

// ---------- 8) 嵌套循环的标签控制流跨越改写边界 ----------

var sum:int = 0;
outer3: for (var i3:int = 0; i3 < 3; i3++) {
  for (var j3:int = 0; j3 < 3; j3++) {
    if (j3 == 1) continue outer3;
    sum++;
  }
}
expect(sum == 3, "labelled continue out of a nested loop (got " + sum + ")");

sum = 0;
blk: for (var i4:int = 0; i4 < 3; i4++) {
  for (var j4:int = 0; j4 < 3; j4++) {
    if (i4 == 1 && j4 == 1) break blk;
    sum++;
  }
}
expect(sum == 4, "labelled break out of a nested loop (got " + sum + ")");

// 内层是「改写」形态（条件不纯）时，标签 continue 必须仍能跳出内层
reset();
sum = 0;
outer4: for (var i5:int = 0; i5 < 3; i5++) {
  p.n = 2;
  for (var j5:int = 0; p.get().n > 0; j5++) { p.n = p.n - 1; sum++; continue outer4; }
}
expect(sum == 3, "labelled continue out of a sequenced inner loop (got " + sum + ")");
expect(Probe.calls == 3, "the inner condition ran once per outer round (got " + Probe.calls + ")");

// 内层「改写」形态里的 break 只退出内层
reset();
sum = 0;
for (var i6:int = 0; i6 < 3; i6++) {
  p.n = 2;
  for (var j6:int = 0; p.get().n > 0; j6++) { sum++; break; }
}
expect(sum == 3, "break in a sequenced inner loop exits only that loop (got " + sum + ")");

trace("loop-once: all assertions passed");