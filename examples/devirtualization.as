// devirtualization.as — leaf-class direct calls preserve AS3 dispatch behavior
import flash.utils.Proxy;
import flash.utils.flash_proxy;

interface IRunner {
  function run():String;
}

class Base {
  public function Base() {}
  public function inherited(value:int):int { return value + 1; }
  public function polymorphic():String { return "base"; }
  public function get accessor():int { return 10; }
}

class Leaf extends Base implements IRunner {
  private var helperCalls:int = 0;
  public function Leaf() { super(); }
  public function helper(value:int):int {
    helperCalls++;
    return value * 2;
  }
  public function callHelper(value:int):int { return helper(value); }
  public function run():String { return "leaf:" + accessor; }
  public override function polymorphic():String { return "leaf"; }
  public function callSuper():String { return super.polymorphic(); }
  public function get helperCount():int { return helperCalls; }
  private function secret():int { return 7; }
  public function callSecret():int { return secret(); }
}

class Derived extends Base {
  public function Derived() { super(); }
  public override function polymorphic():String { return "derived"; }
}

dynamic class LeafProxy extends Proxy {
  flash_proxy override function callProperty(name:*, ...rest):* {
    return "proxy:" + String(name) + ":" + rest.length;
  }
}

function check(condition:Boolean, label:String):void {
  if (!condition) throw new Error("devirtualization: " + label);
}

var leaf:Leaf = new Leaf();
var argumentCalls:int = 0;
var receiverCalls:int = 0;
function nextValue():int { argumentCalls++; return 4; }
function currentLeaf():Leaf { receiverCalls++; return leaf; }

check(leaf.inherited(4) == 5, "inherited owner");
check(leaf.callHelper(3) == 6 && leaf.helperCount == 1, "implicit this call");
check(leaf.callSecret() == 7, "private dispatch unchanged");
check(leaf.run() == "leaf:10", "getter dispatch unchanged");
check(leaf.callSuper() == "base", "super direct call");

var base:Base = new Derived();
check(base.polymorphic() == "derived", "base reference stays virtual");
var dynamicReceiver:* = leaf;
check(dynamicReceiver.run() == "leaf:10", "dynamic dispatch unchanged");
var runner:IRunner = leaf;
check(runner.run() == "leaf:10", "interface dispatch unchanged");
var proxy:LeafProxy = new LeafProxy();
check(proxy.proxied(3) == "proxy:proxied:1", "Proxy dispatch unchanged");

check(currentLeaf().inherited(nextValue()) == 5, "direct result");
check(receiverCalls == 1 && argumentCalls == 1, "receiver and argument evaluate once");

var nullLeaf:Leaf = null;
try {
  nullLeaf.inherited(nextValue());
  check(false, "null receiver must throw");
} catch (error:TypeError) {
  check(error.errorID == 1009, "null receiver keeps #1009");
}
check(argumentCalls == 2, "null receiver evaluates arguments before #1009");

var withResult:int = 0;
with (leaf) { withResult = callHelper(5); }
check(withResult == 10 && leaf.helperCount == 2, "sealed with call");

trace("devirtualization: OK");
