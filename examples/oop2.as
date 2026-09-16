// const, static, getter/setter, final.

const GLOBAL_MAX:int = 100;
trace("global const:", GLOBAL_MAX);

class Counter {
  const LIMIT:int = 10;
  static var total:int = 0;
  var _count:int;

  function Counter() { _count = 0; }

  function inc():int {
    _count = _count + 1;
    total = total + 1;
    return _count;
  }

  static function getTotal():int {
    return total;
  }

  function get count():int {
    return _count;
  }

  function set count(v:int) {
    _count = v;
  }
}

var c:Counter = new Counter();
trace(c.inc());          // 1
trace(c.inc());          // 2
trace(Counter.total);    // 2
trace(Counter.getTotal()); // 2
trace(Counter.LIMIT);    // 10

c.count = 50;            // setter
trace(c.count);          // 50 (getter)
