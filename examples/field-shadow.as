// field-shadow.as — 类字段遮蔽（私有槽不合并）+ 容器元素自增 + label 后接声明
//
// 本文件覆盖阶段八十九·四十四 的三个「C 槽位 / 左值」缺陷，它们都表现为
// 「生成 C 看着像对的、语义却错」或「直接不是合法 C」：
//
// 1) **同名字段遮蔽（Starling demo Masks 场景点不出来/返回按钮消失的真凶）**
//    AS3 把 private 成员按「声明它的类」分命名空间：子类 `private var _mask` 与
//    父类同名字段是**两个不同的槽**。此前字段表以「名字」为键扁平化继承，子类声明
//    会**覆盖**父类那条（Map.set 同名覆盖），于是两者共用同一个 C 成员：
//      `DisplayObject._mask`（真遮罩槽，父类方法经父类指针访问）与
//      `MaskScene._mask`（子类自己的 Canvas）被合并成一个。
//    Starling 的 MaskScene 构造里 `this->_mask = createCircle()` 于是写进了
//    DisplayObject 的遮罩槽 → 父容器把**整个场景**当成遮罩对象，drawMask 把同帧
//    后续绘制的兄弟节点（返回按钮）一起模板裁剪掉，返回按钮消失。
//    修法：`symbols.ts` 扁平化时检测跨类同名声明，给遮蔽方一个独立的 C 槽名
//    （`_v__SlotMid`），被遮蔽方保留原名与偏移（父类方法经父类指针访问仍命中），
//    AS3 名 → C 槽名的映射记在 `ClassInfo.fieldKeys`，访问按「声明它的类」解析。
//
// 2) **容器元素自增 `x[i]++` 不是合法 C**
//    Array / Vector / Dictionary / dynamic 对象的元素经运行时访问器读写，没有 C
//    左值，旧代码直接拼 `as_array_get(a, i)++` → 编译报错（`d[k]++` 这种写法在
//    AS3 里很常见）。修法：按 ES3 §11.3.1/§11.4.1 展开成读-改-写
//      `++x[i]` → `n = Number(x[i]); x[i] = n + 1; 结果 = n + 1`
//      `x[i]++` → `n = Number(x[i]); x[i] = n + 1; 结果 = n`
//    注意运算符自带的 **ToNumber**：元素是字符串 `"5"` 时 `x[i]++` 得 5、存 6，
//    而不是 `"5" + 1` 的 `"51"`。取值上下文若不能预先求值（`?:` / `&&` 分支），
//    读改写折叠成一个逗号表达式，副作用留在分支内（未走的分支不留痕）。
//
// 3) **`case`/`default` 标签后紧跟声明**
//    提升进 `case` 体的临时变量声明（如不纯接收者 `_onceN`）会直接跟在标签后面，
//    而 C11 不允许「标签后直接是声明」（C23 才允许）—— emcc 直接报
//    `expected expression`。修法：每个标签后补一个空语句 `;`（与既有
//    `_lbl__continue: ;` 风格一致）。
//
// 反向对照（把修复撤掉，本例必须失败）：
//   RC1 字段遮蔽：把 `_v__SlotMid` 改回同名合并 → 两槽互相串写，第 1 节断言失败。
//   RC2 容器自增：把 `indexUpdateStore` 换回 `x[i]++` 直拼 → 编译不过（硬失败）。
//   RC3 ToNumber：把 `Number(x[i])` 换成 `x[i]` → 字符串元素断言失败（得 "51"）。
//   RC4 分支内副作用：把逗号表达式换成无条件前置语句 → 「未走分支不留痕」断言失败。
//   RC5 label+声明：撤掉标签后的 `;` → emcc / clang -std=c11 报错，编译不过。

function expect(cond:Boolean, msg:String):void {
  if (!cond) throw new Error("FAIL: " + msg);
}

// ---------- 1) 私有字段遮蔽：父子各占一个槽 ----------

class SlotBase {
  private var _v:int = 1;
  private var _name:String = "base";
  private var _list:Array = [1];
  private var _num:Number;                  // 未初始化 Number → NaN
  protected var _shared:int = 10;

  public function baseV():int { return _v; }
  public function setBaseV(x:int):void { _v = x; }
  public function baseName():String { return _name; }
  public function baseListLen():int { return _list.length; }
  public function baseListPush(x:int):void { _list.push(x); }
  public function baseNumIsNaN():Boolean { return _num != _num; }
  public function baseShared():int { return _shared; }
  public function bothVs():String { return _v + "/" + _name; }
}

class SlotMid extends SlotBase {
  private var _v:int = 100;                 // 遮蔽父类的 _v（父类的 _v 不可见，故无歧义）
  private var _list:Array = [2, 2];         // 遮蔽父类的 _list（引用类型）

  public function midV():int { return _v; }
  public function setMidV(x:int):void { _v = x; }
  public function midListLen():int { return _list.length; }
  public function midListPush(x:int):void { _list.push(x); }
  // 自己的槽 + 父类的槽（经父类的 public 访问器）——AS3 的 private 不进入子类命名空间，
  // 所以子类只能读自己的 `_v`，父类的那个必须经父类方法访问；两个槽都要各自存活。
  public function midVsBase():String { return _v + "/" + baseV() + "/" + _shared; }
}

class SlotLeaf extends SlotMid {
  // 自己不再声明 _v：两代的 _v 槽都随继承保留，各自经声明它的类的访问器读写

  public function leafVsBase():String { return midV() + "/" + baseV(); }
  public function leafShared():int { return _shared; }
}

var slotBase:SlotBase = new SlotBase();
var slotMid:SlotMid = new SlotMid();
var slotLeaf:SlotLeaf = new SlotLeaf();

expect(slotBase.baseV() == 1, "base's own _v starts at 1 (got " + slotBase.baseV() + ")");
expect(slotMid.baseV() == 1, "mid inherits base's _v = 1 (got " + slotMid.baseV() + ")");
expect(slotMid.midV() == 100, "mid's own _v starts at 100 (got " + slotMid.midV() + ")");
expect(slotMid.bothVs() == "1/base", "a base method reads the base's _v/_name (got " + slotMid.bothVs() + ")");
expect(slotMid.midVsBase() == "100/1/10", "mid reads its own _v and the base's via baseV() (got " + slotMid.midVsBase() + ")");
expect(slotLeaf.leafVsBase() == "100/1", "both slots survive a further inheritance level (got " + slotLeaf.leafVsBase() + ")");
expect(slotLeaf.leafShared() == 10, "protected inherited field unaffected (got " + slotLeaf.leafShared() + ")");

// 写父类槽不影响子类槽，反之亦然（两槽不合并 = 不互相串写）
slotMid.setBaseV(7);
expect(slotMid.baseV() == 7 && slotMid.midV() == 100, "writing the base slot leaves the mid slot alone (got " + slotMid.baseV() + "/" + slotMid.midV() + ")");
slotMid.setMidV(8);
expect(slotMid.baseV() == 7 && slotMid.midV() == 8, "writing the mid slot leaves the base slot alone (got " + slotMid.baseV() + "/" + slotMid.midV() + ")");
// 再下一层同样两个槽都在：分别写两槽，互不干扰
slotLeaf.setBaseV(3);
slotLeaf.setMidV(4);
expect(slotLeaf.leafVsBase() == "4/3", "a further subclass keeps both slots independent (got " + slotLeaf.leafVsBase() + ")");

// 引用类型字段同样各占一个槽（这是 Masks 里 `_mask` 的形态：对象引用）
expect(slotBase.baseListLen() == 1, "base's _list has 1 element (got " + slotBase.baseListLen() + ")");
expect(slotMid.baseListLen() == 1 && slotMid.midListLen() == 2, "mid's shadowing _list is its own (got " + slotMid.baseListLen() + "/" + slotMid.midListLen() + ")");
slotMid.baseListPush(5);
expect(slotMid.baseListLen() == 2 && slotMid.midListLen() == 2, "pushing to the base slot leaves the mid slot at 2 (got " + slotMid.baseListLen() + "/" + slotMid.midListLen() + ")");
slotMid.midListPush(6);
expect(slotMid.baseListLen() == 2 && slotMid.midListLen() == 3, "pushing to the mid slot leaves the base slot at 2 (got " + slotMid.baseListLen() + "/" + slotMid.midListLen() + ")");

// 未初始化的 Number 字段默认 NaN（两个槽各自初始化，互不干扰）
expect(slotBase.baseNumIsNaN(), "an uninitialised Number field defaults to NaN");
expect(slotBase.baseNumIsNaN() && slotMid.baseNumIsNaN(), "and stays NaN in the shadowing subclass");

// ---------- 2) 容器元素自增：读-改-写 + ToNumber ----------

var arr:Array = [5];
var v1:int = arr[0]++;
expect(v1 == 5 && arr[0] == 6, "Array postfix yields the old element and stores +1 (got " + v1 + "/" + arr[0] + ")");
var v2:int = ++arr[0];
expect(v2 == 7 && arr[0] == 7, "Array prefix yields the new element (got " + v2 + "/" + arr[0] + ")");
arr[0] += 10;
expect(arr[0] == 17, "compound assignment on an element still works (got " + arr[0] + ")");
arr[0]--;
expect(arr[0] == 16, "a bare element decrement statement works (got " + arr[0] + ")");

// 元素是字符串："5" → ToNumber 得 5，存 6（不是 "51"）
var strArr:Array = ["5"];
var v3:int = strArr[0]++;
expect(v3 == 5 && strArr[0] == 6, "++ applies ToNumber to a String element (got " + v3 + "/" + strArr[0] + ")");

var dict:Dictionary = new Dictionary();
dict["k"] = 7;
var v4:int = dict["k"]++;
expect(v4 == 7 && dict["k"] == 8, "Dictionary element postfix (got " + v4 + "/" + dict["k"] + ")");
var v5:int = ++dict["k"];
expect(v5 == 9 && dict["k"] == 9, "Dictionary element prefix (got " + v5 + "/" + dict["k"] + ")");

var dyn:Object = { n: 1 };
dyn["n"]++;
expect(dyn["n"] == 2, "dynamic object element increment (got " + dyn["n"] + ")");

var vec:Vector.<int> = new Vector.<int>(3, true);
vec[1] = 4;
vec[1]++;
expect(vec[1] == 5, "Vector element increment (got " + vec[1] + ")");

// ---------- 3) 分支内的自增：副作用必须留在分支内 ----------

var flag:Boolean = true;
var no:Boolean = false;

var branchArr:Array = [5];
var p1:int = flag ? branchArr[0]++ : 0;
expect(p1 == 5 && branchArr[0] == 6, "a ?: branch postfix yields the old element (got " + p1 + "/" + branchArr[0] + ")");
var p2:int = flag ? ++branchArr[0] : 0;
expect(p2 == 7 && branchArr[0] == 7, "a ?: branch prefix yields the new element (got " + p2 + "/" + branchArr[0] + ")");
var p3:int = no ? branchArr[0]++ : 99;
expect(p3 == 99 && branchArr[0] == 7, "the untaken branch leaves no trace (got " + p3 + "/" + branchArr[0] + ")");
var p4:int = no ? ++branchArr[0] : 99;
expect(p4 == 99 && branchArr[0] == 7, "nor for the prefix form (got " + p4 + "/" + branchArr[0] + ")");

// 同样的形态出现在 getter/setter 属性上（属性读也不是 C 左值）
class Counter {
  private var _n:int = 5;
  public function get n():int { return _n; }
  public function set n(v:int):void { _n = v; }
  public function self():Counter { return this; }
}
var cnt:Counter = new Counter();
var q1:int = flag ? cnt.n++ : 0;
expect(q1 == 5 && cnt.n == 6, "a ?: branch postfix on an accessor property (got " + q1 + "/" + cnt.n + ")");
var q2:int = flag ? ++cnt.n : 0;
expect(q2 == 7 && cnt.n == 7, "a ?: branch prefix on an accessor property (got " + q2 + "/" + cnt.n + ")");
var q3:int = no ? cnt.n++ : 99;
expect(q3 == 99 && cnt.n == 7, "the untaken accessor branch leaves no trace (got " + q3 + "/" + cnt.n + ")");
cnt.n++;
expect(cnt.n == 8, "a bare accessor increment statement still works (got " + cnt.n + ")");
var q4:int = cnt.n += 3;
expect(q4 == 11 && cnt.n == 11, "a compound accessor assignment yields the new value (got " + q4 + "/" + cnt.n + ")");

// ---------- 4) `case` 标签后紧跟声明（生成 C 必须仍是合法 C11） ----------
//
// `who.self().n` 的接收者不纯，会被提升成 `case` 体内的 `_onceN` 声明；标签后必须
// 先有一个空语句，否则 `case 0:` 后直接是声明，C11 不合法（emcc 报 expected
// expression）。本节同时也是容器/属性自增在 switch 分支内的回归。

function pick(k:int, who:Counter):int {
  switch (k) {
    case 0: {
      var a:int = who.self().n;
      return a;
    }
    default: {
      var b:int = who.self().n + 1;
      return b;
    }
  }
  return -1;
}
expect(pick(0, cnt) == 11, "case-body hoisted receiver works (got " + pick(0, cnt) + ")");
expect(pick(9, cnt) == 12, "default-body hoisted receiver works (got " + pick(9, cnt) + ")");

var swArr:Array = [2, 2];
function pickElem(k:int, a:Array):int {
  switch (k) {
    case 0: {
      var x:int = a[0]++;
      return x;
    }
    default: {
      var y:int = ++a[0];
      return y;
    }
  }
  return -1;
}
expect(pickElem(0, swArr) == 2 && swArr[0] == 3, "element postfix inside a case (got " + pickElem(0, swArr) + ")");

trace("field-shadow: all assertions passed");