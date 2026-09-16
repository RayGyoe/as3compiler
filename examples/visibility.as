class Base {
  public var pub:int = 1;
  private var priv:int = 2;
  protected var prot:int = 3;

  function getPriv():int {
    return this.priv;
  }
}

class Derived extends Base {
  function getProt():int {
    return this.prot;
  }
}

var b = new Base();
trace(b.pub);
trace(b.getPriv());

var d = new Derived();
trace(d.getProt());
trace(d.pub);
