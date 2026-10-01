// expr-once.as — 每个子表达式只求值一次（阶段八十九·三十八：重复求值审计）。
//
// AS3 规定一个操作里的每个操作数**按从左到右各求值一次**。生成 C 的某些形态会把
// 同一个操作数内联到同一语句的多处：
//   * 接口 `==`：`a.obj == b.obj && a.vt == b.vt`（两个操作数各出现两次）
//   * `as` 转换：先 `as_v_is_inst(x, …)` 判定、再 `(T*)as_v_obj_val(x)` 取值
//   * 成员写：`x->f = v, gc_write_barrier((void*)(x->f)), (x->f)`（接收者三次）
//   * 属性 getter 读：`x->vtable->get_f(x)`（接收者两次）
//   * `Function` 值调用：`f->fn(f->env, …)`（被调值两次）
//   * `String.replace(re)`：`re->compiled` 与 `re->global`（正则参数两次）
//   * `Boolean(s)`：`s != NULL && strlen(s) > 0`（字符串参数两次）
// 操作数若是带副作用的调用（`box.get()`、`next()`、`h.mkRe()`），上述形态就会把
// 它**求值两次/三次**——这是可观测的语义差异（AIR 只求值一次）。本例用静态计数器
// 统计每次调用被执行了几次，逐条与「一次」对照；计数不符即抛断言错误。
//
// 修法见 `emit.ts` 的 `hoistImpure`：凡在生成的 C 里出现多次的操作数（且保证会执行），
// 先落一个临时变量再各处引用；纯操作数（变量/字面量/字段链）不增加临时量。

interface Marker { }

class Probe2 implements Marker {
  public static var calls:int = 0;
  private var _w:Number = 1.5;
  public var f:String = "F";
  public function Probe2() { }
  public function get w():Number { return _w; }
  public function set w(v:Number):void { _w = v; }
  public function get():Probe2 { Probe2.calls++; return this; }
  public function getAny():* { Probe2.calls++; return this; }
  public function m():int { return 3; }
  public function mkRe():RegExp { Probe2.calls++; return /a/g; }
  public function getFn2():Function { Probe2.calls++; return m2; }
  public function m2():int { return 9; }
  public function asMarker():Marker { Probe2.calls++; return this; }
}

class Ctor2 { public function Ctor2(a:int = 0, b:int = 0) { } }
class Sub2 extends Ctor2 { public function Sub2(a:int) { super(a); } }

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

var probe:Probe2 = new Probe2();
function reset():void { Probe2.calls = 0; }

// ---------- 1) 接收者被内联多次的形态 ----------

reset();
var wv:Number = probe.get().w;                       // getter 读：接收者两次
expect(Probe2.calls == 1, "a getter read evaluates its receiver once (got " + Probe2.calls + ")");
expect(wv == 1.5, "and still reads the property (got " + wv + ")");

reset();
probe.get().w = 2.5;                                 // setter 写
expect(Probe2.calls == 1, "a setter write evaluates its receiver once (got " + Probe2.calls + ")");
expect(probe.w == 2.5, "and still writes the property (got " + probe.w + ")");

reset();
probe.get().f += "!";                                // 普通字段读改写
expect(Probe2.calls == 1, "a field += evaluates its receiver once (got " + Probe2.calls + ")");
expect(probe.f == "F!", "and still updates the field (got " + probe.f + ")");

reset();
probe.get().f = "G";                                 // 普通字段写：接收者三次（存值/写屏障/表达式的值）
expect(Probe2.calls == 1, "a field write evaluates its receiver once (got " + Probe2.calls + ")");
expect(probe.f == "G", "and still stores the field (got " + probe.f + ")");

reset();
var lbl:String = probe.get().f;                      // 普通字段读：接收者本只出现一次
expect(Probe2.calls == 1, "a field read evaluates its receiver once (got " + Probe2.calls + ")");
expect(lbl == "G", "and still reads the field (got " + lbl + ")");

reset();
var mv:int = probe.get().m();                        // 方法调用：接收者两次（vtable + this）
expect(Probe2.calls == 1, "a method call evaluates its receiver once (got " + Probe2.calls + ")");
expect(mv == 3, "and still calls the method (got " + mv + ")");

reset();
var chained:int = probe.get().get().m();             // 链式：两次 get() 就是两次求值
expect(Probe2.calls == 2, "a two-link receiver chain evaluates each link once (got " + Probe2.calls + ")");
expect(chained == 3, "and still reaches the method (got " + chained + ")");

reset();
var anyOut:String = (probe.getAny()).f;              // `*` 接收者（走反射表）
expect(Probe2.calls == 1, "a dynamic (any) field read evaluates its receiver once (got " + Probe2.calls + ")");
expect(anyOut == "G", "and still reads through the reflection table (got " + anyOut + ")");

// ---------- 2) 操作数被内联多次的形态 ----------

reset();
var i1:Marker = probe.asMarker();
reset();
var eqSame:Boolean = probe.asMarker() == i1;         // 接口 ==：操作数两次
expect(Probe2.calls == 1, "an interface == evaluates each operand once (got " + Probe2.calls + ")");
expect(eqSame, "and still compares equal (got " + eqSame + ")");

reset();
var asOk:Boolean = (probe.get() as Probe2) != null;  // as：先判定后取值
expect(Probe2.calls == 1, "an `as` cast evaluates its operand once (got " + Probe2.calls + ")");
expect(asOk, "and still converts (got " + asOk + ")");

reset();
var isOk:Boolean = probe.get() is Probe2;
expect(Probe2.calls == 1, "an `is` test evaluates its operand once (got " + Probe2.calls + ")");
expect(isOk, "and still tests the type (got " + isOk + ")");

reset();
var callRes:int = probe.getFn2()();                  // 经 `Function` 值调用：`f()->fn(f()->env…)` 读被调值两次
expect(Probe2.calls == 1, "a call through a returned closure evaluates the callee once (got " + Probe2.calls + ")");
expect(callRes == 9, "and still invokes it (got " + callRes + ")");

reset();
var replaced:String = "aXa".replace(probe.mkRe(), "b");   // 正则参数：->compiled / ->global
expect(Probe2.calls == 1, "replace(re) evaluates the regex argument once (got " + Probe2.calls + ")");
expect(replaced == "bXb", "and still replaces all matches (got " + replaced + ")");

reset();
var matched:Array = "aXa".match(probe.mkRe());
expect(Probe2.calls == 1, "match(re) evaluates the regex argument once (got " + Probe2.calls + ")");
expect(matched.length == 2, "and still collects the matches (got " + matched.length + ")");

reset();
var searched:int = "aXa".search(probe.mkRe());
expect(Probe2.calls == 1, "search(re) evaluates the regex argument once (got " + Probe2.calls + ")");
expect(searched == 0, "and still finds the position (got " + searched + ")");

reset();
var boolObj:Boolean = Boolean(probe.get());          // Boolean(s)：参数两次（!= NULL && strlen() > 0）
expect(Probe2.calls == 1, "Boolean(x) evaluates its argument once (got " + Probe2.calls + ")");
expect(boolObj, "and a non-null object converts to true (got " + boolObj + ")");

// ---------- 3) 只求值一次的语境（含模块级初始化） ----------

reset();
var acc:int = 0;
for (var fi:int = probe.get().m(); fi > 0; fi--) { acc += fi; }
expect(Probe2.calls == 1, "a `for` init is evaluated once (got " + Probe2.calls + ")");
expect(acc == 6, "and the loop still runs (got " + acc + ")");

reset();
try { throw new Error("boom" + probe.get().m()); } catch (e:Error) { }
expect(Probe2.calls == 1, "a thrown value is evaluated once (got " + Probe2.calls + ")");

reset();
var ctor2:Ctor2 = new Ctor2(probe.get().m(), probe.get().m());
expect(Probe2.calls == 2, "each constructor argument is evaluated once (got " + Probe2.calls + ")");

reset();
var lit2:Array = [probe.get().m(), probe.get().m()];
expect(Probe2.calls == 2, "each array-literal element is evaluated once (got " + Probe2.calls + ")");
expect(lit2.length == 2, "and the literal still holds both (got " + lit2.length + ")");

reset();
var sub2:Sub2 = new Sub2(probe.get().m());
expect(Probe2.calls == 1, "a super() argument is evaluated once (got " + Probe2.calls + ")");

// 注：上面第 1 节的 `var mv:int = probe.get().m();` 是**模块级**初始化，走的是
// emitTopLevel 的另一条路径（不经 emitVarDecl），此前少了 sequenceValueExpr 这一遍，
// 故它会把 get() 内联两次；函数内初始化（`var wv:Number = probe.get().w;` 等）走
// emitStmt 的路径，两条都必须各求值一次。

// ---------- 4) 同批修正：真值语义（引用与 NaN，AIR 51.4.1 实测对照） ----------
// AS3 的规则是「null/undefined/0/NaN/空串 为 false，其余为 true」——**非空引用恒为 true**，
// 而不是 `ToNumber(v) != 0`（后者对任何对象都得 false）。AIR 实测：Boolean({})、
// Boolean([])、Boolean(new Sprite())、Boolean(接口值) 全为 true，而 int(obj)==0、Number(obj)==NaN。
var boolObjLit:Object = { a: 1 };
var boolArr:Array = [];
var boolVec:Vector.<int> = new Vector.<int>();
var boolDict:Dictionary = new Dictionary();
var boolMarker:Marker = new Probe2();
var boolFn:Function = function():void { };
expect(Boolean(boolObjLit), "Boolean({}) is true");
expect(Boolean(boolArr), "Boolean([]) is true (an empty Array is still a reference)");
expect(Boolean(boolVec), "Boolean(Vector) is true");
expect(Boolean(boolDict), "Boolean(Dictionary) is true");
expect(Boolean(boolMarker), "Boolean(interface value) is true");
expect(Boolean(boolFn), "Boolean(Function) is true");
var boolNull:String = null;
expect(!Boolean(boolNull), "Boolean(null) is false");
expect(!Boolean(0), "Boolean(0) is false");
expect(!Boolean(""), "Boolean('') is false");
expect(Boolean("x"), "Boolean('x') is true");

// NaN 同样是假值，而 C 的 `if (d)` 会把 NaN 当**真**（`NaN != 0` 为真），故静态
// number 类型与装箱（`any`）两条路径都必须走 `as_num_truthy`（AIR 实测：NaN 为假）。
var nanVal:Number = 0 / 0;
var nanAny:* = nanVal;
expect(!Boolean(nanVal), "Boolean(NaN) is false");
expect(!Boolean(nanAny), "Boolean(NaN) is false through the boxed path too");
expect(!nanVal, "a NaN condition is falsy (C's own test would call it truthy)");
if (nanVal) { throw new Error("FAIL: if (NaN) must not run the then-branch"); }
expect(!nanAny, "a boxed NaN condition is falsy");
expect((nanVal ? "T" : "F") == "F", "a NaN ternary selects the else branch");
expect((nanAny ? "T" : "F") == "F", "a boxed NaN ternary selects the else branch");
var zeroDiv:Number = 0 / 0;
expect(!zeroDiv, "0/0 is falsy");
expect(Boolean(1) && !Boolean(0), "1 is truthy and 0 is falsy");

trace("expr-once: all assertions passed");