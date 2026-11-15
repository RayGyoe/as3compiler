// error-stacktrace.as — Error.getStackTrace() 的 AS3 栈帧模型（阶段四百三十一）。
// AIR（adl 51.4.1，temp/stackprobe）在 Error **构造时**捕获调用栈，文本形如：
//   Error: deep boom
//   	at StackProbe/level3()
//   	at StackProbe/level2()
//   	at StackProbe()
// 要点：header 是 "name: message"；方法帧 Class/method()；构造器帧 Class()；
// 自由函数帧 global/fn()；内层帧在前；构造未 throw 也有栈；rethrow 保留原栈。
// ADL 运行时帧（runtime::ContentPlayer 等）来自另一个加载器，不复现。

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Deep {
  public function level1():void { level2(); }
  private function level2():void { level3(); }
  private function level3():void { throw new Error("deep boom"); }
  public function make():Error { return new Error("made"); }
  public static function statThrow():void { throw new Error("static boom"); }
}

class CtorProbe {
  public var stack:String;
  public function CtorProbe() { stack = new Error("in ctor").getStackTrace(); }
}

function freeThrow():void { throw new Error("free boom"); }

var carried:Error = null;
function stash():void { carried = new Error("carried"); }

// void 函数 return voidCall()（真应用 RWebSocket.sendMessage / TextField.appendText 模式）。
function voidSink(m:String):void { }
function voidRelay(m:String):void { return voidSink(m); }
function voidRelayTry(m:String):void { try { return voidSink(m); } finally { } }

// 1) 构造未 throw：构造点就有栈。顶层构造至少带脚本帧 global()。
var e0:Error = new Error("not thrown");
var s0:String = e0.getStackTrace();
check(s0 != null, "constructed Error must have a stack");
check(s0.indexOf("Error: not thrown\n") == 0, "header 'Error: not thrown' + newline, got: " + s0);
check(s0.indexOf("\tat global()") >= 0, "top-level script frame global(), got: " + s0);

// 2) 方法 throw：内层在前，逐帧 Class/method()。
var d:Deep = new Deep();
try { d.level1(); } catch (e:Error) {
  var s:String = e.getStackTrace();
  check(s.indexOf("Error: deep boom\n") == 0, "method header, got: " + s);
  var i3:int = s.indexOf("\tat Deep/level3()\n");
  var i2:int = s.indexOf("\tat Deep/level2()\n");
  var i1:int = s.indexOf("\tat Deep/level1()\n");
  check(i3 >= 0 && i2 >= 0 && i1 >= 0, "all three method frames present: " + s);
  check(i3 < i2 && i2 < i1, "innermost frame first: " + s);
}

// 3) 构造器帧 Class()（无 /method），同样是构造点捕获。
var cp:CtorProbe = new CtorProbe();
check(cp.stack.indexOf("\tat CtorProbe()\n") >= 0, "ctor frame CtorProbe(): " + cp.stack);
check(cp.stack.indexOf("Error: in ctor\n") == 0, "ctor-captured header: " + cp.stack);

// 4) 自由函数帧 global/fn()。
try { freeThrow(); } catch (fe:Error) {
  check(fe.getStackTrace().indexOf("\tat global/freeThrow()\n") >= 0, "free frame: " + fe.getStackTrace());
}

// 5) 静态方法帧 Cls$/method()（AVM2 静态侧命名）。
try { Deep.statThrow(); } catch (se:Error) {
  check(se.getStackTrace().indexOf("\tat Deep$/statThrow()\n") >= 0, "static frame: " + se.getStackTrace());
}

// 6) 子类用自己的 name 做 header。
try { throw new TypeError("bad type"); } catch (te:TypeError) {
  check(te.getStackTrace().indexOf("TypeError: bad type\n") == 0, "subclass header: " + te.getStackTrace());
}

// 7) 构造点捕获而非 throw 点：stash() 里构造，稍后在顶层 throw。
stash();
try { throw carried; } catch (ce:Error) {
  var cs:String = ce.getStackTrace();
  check(cs.indexOf("\tat global/stash()\n") >= 0, "construction-site frame kept: " + cs);
}

// 8) rethrow 保留原始栈。
try { try { d.level1(); } catch (e3:Error) { throw e3; } } catch (e4:Error) {
  check(e4.getStackTrace().indexOf("\tat Deep/level3()\n") >= 0, "rethrow keeps original frames: " + e4.getStackTrace());
}

// 9) `return new Error(...)`：返回值求值时本函数帧必须还在。
var me:Error = d.make();
check(me.getStackTrace().indexOf("\tat Deep/make()\n") >= 0, "return-new frame: " + me.getStackTrace());

// 10) catch 之后深度已恢复：新 Error 的栈不得残留 level 帧。
var after:Error = new Error("after");
check(after.getStackTrace().indexOf("level3") < 0, "depth restored after catch: " + after.getStackTrace());

// 11) void 函数 `return voidCall();`：不得 hoist 成非法的 `void _ret = ...`（阶段四百三十一回归）。
voidRelay("x"); voidRelayTry("y");

trace("PASS error-stacktrace");
