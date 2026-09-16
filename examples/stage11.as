// stage11.as — 闭包（捕获外部局部变量、逃逸、可变捕获）

function makeCounter():Function {
  var n = 0;
  return function() { return ++n; };
}

function makeAdder(base:int):Function {
  return function(x:int):int { return base + x; };
}

function testClosure(): void {
  var c1:Function = makeCounter();
  var c2:Function = makeCounter();

  trace("c1: " + c1());
  trace("c1: " + c1());
  trace("c1: " + c1());
  trace("c2: " + c2());
  trace("c2: " + c2());

  var add5:Function = makeAdder(5);
  trace("add5(3): " + add5(3));
  trace("add5(10): " + add5(10));
}

testClosure();
