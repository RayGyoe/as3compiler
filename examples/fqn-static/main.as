// 阶段二百一十七：类引用的「全限定名」形式（`pkg.sub.Cls.member`）与短名必须解析到**同一份**
// 静态 traits —— 读、写、调用、静态访问器、静态只读类，五种形态各自都要成立。
//
// 触发这个钉子的真缺陷：`flash.filesystem.File.applicationDirectory.nativePath` 抛
// `Error #1010`，而短名 `File.applicationDirectory.nativePath` 正常 —— 全限定名落到了动态
// Class 值查表（`as_class_member_value`），那张表只有 `walkInferType` 能定型的名字，而它给
// `pkg.Cls` 这种链定型不了 ⇒ 表里没有这些名字 ⇒ 读回 undefined ⇒ 后续 `.nativePath` 炸。
//
// AIR 真值：mxmlc + adl 51.4.1 的双写对照，24 行逐字相同（temp/fqnadl/）。
import flash.desktop.NativeApplication;
import flash.filesystem.File;
import flash.system.Capabilities;
import fqnprobe.C;
import fqnprobe.D;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function run():void {
  // ① 内置静态（用户报的那条）：两种写法读同一个目录。
  check(File.applicationDirectory.nativePath.length > 0, "short File.applicationDirectory");
  check(flash.filesystem.File.applicationDirectory.nativePath == File.applicationDirectory.nativePath,
        "FQN File.applicationDirectory == short");
  check(flash.filesystem.File.userDirectory.nativePath == File.userDirectory.nativePath,
        "FQN File.userDirectory == short");

  // ② 静态只读类（没有 ClassInfo，静态成员由硬编码发射器给出）的全限定名。
  check(flash.system.Capabilities.version == Capabilities.version, "FQN Capabilities.version == short");
  check(flash.system.System.privateMemory > 0, "FQN System.privateMemory");
  flash.system.System.gc();
  System.gc();

  // ③ 内置 static getter 的全限定名。
  check(flash.desktop.NativeApplication.nativeApplication == NativeApplication.nativeApplication,
        "FQN NativeApplication.nativeApplication == short");

  // ④ 自己写的类（带包名）：静态字段 / 常量 / getter / 方法 / 函数值字段，两式读同一槽。
  check(C.field == fqnprobe.C.field, "static field: short == FQN");
  check(C.K == fqnprobe.C.K, "static const: short == FQN");
  check(C.seven == fqnprobe.C.seven, "static getter: short == FQN");
  check(C.m() == fqnprobe.C.m(), "static method: short == FQN");
  check(D.getTime() == fqnprobe.D.getTime() && D.getTime() == 42, "static Function field call: short == FQN");

  // ⑤ 静态**写**（字段与 setter）也走同一槽，含复合赋值与链式读回。
  C.field = 50;
  check(fqnprobe.C.field == 50, "FQN reads back a short-form write");
  fqnprobe.C.field = 60;
  check(C.field == 60, "short reads back an FQN write");
  fqnprobe.C.field += 5;
  check(C.field == 65, "FQN compound assignment");
  C.s = 3;
  check(fqnprobe.C.s == 6, "static setter: FQN getter sees a short-form write");
  fqnprobe.C.s = 4;
  check(C.s == 8, "static setter: short getter sees an FQN write");

  // ⑥ 阶段三百二十六：括号形式读静态成员
  //    `Cls["name"]` 与 `Cls.name` 在 AIR 里是同一个 trait 查询，两式必须同值；
  //    字符串字面量键在编译期规约成点式，**计算**键才走运行期查表。
  check(C["field"] == 65, "Cls['field'] reads the same slot as Cls.field");
  check(flash.filesystem.File["separator"] == File.separator, "FQN Cls['separator'] == short");
  // 计算键（`Cls[n]`）仍走运行期静态表，而那张表只收 emit 阶段定型过的名字 —— 用户类
  // 的静态成员因此还会读回 undefined。AIR 会回到真值，故这是**已登记**的遗留项，
  // 不在这里断言成「正确行为」。

  // ⑦ 阶段三百二十六：链首段被变量遮蔽 ⇒ 整条链是**值上的成员走查**，不是包路径。
  //    AIR 在 null 接收者上抛 #1009；把链当类引用会静默读出静态值（最坏的一类错）。
  function errId(fn:Function):int {
    try { fn(); } catch (err:Error) { return err.errorID; }
    return 0;
  }
  var pkg:Object = null;
  check(errId(function():void { var v:* = pkg.fqnprobe.C.field; }) == 1009, "a shadowed chain root is a null receiver (#1009)");
  var live:Object = { fqnprobe: { C: { field: 77 } } };
  check(live.fqnprobe.C.field == 77, "a live value chain resolves through the object");
  check(live.fqnprobe.C["field"] == 77, "a live value chain resolves through the bracket form too");
}

run();
trace("fqn-static: ok");
