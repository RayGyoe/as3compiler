// Sibling nested functions that CALL EACH OTHER (stage 三百五十).
//
// AS3 hoists function declarations to the top of the enclosing function, so two
// nested functions can call each other (even mutually, before either is written).
// Our emitter serves such a call through a shared activation cell owned by the
// enclosing body: `_cellN` holds one `as_fn` slot per sibling, and the body must
// declare `_cellN* cellN = _cellN_alloc();` before the first call site.
//
// The CONSTRUCTOR path never emitted that declaration, so a class whose
// constructor declared such a pair produced C that did not compile at all
// (`use of undeclared identifier 'cell2'`) -- every sibling call in the ctor was
// dead on arrival. Same story for a class-body static block.
//
// Expected output (verified against adl 51.4.1, temp/nsfair/):
//   007/9
//   even
//   v8

class Counter {
  public var label:String = "";
  public var parity:String = "";
  public var doubled:String = "";

  public function Counter(start:int) {
    var pad:String = doPad(start, 3);
    label = pad + "/" + bumpBy(2);
    parity = isEven(6) ? "even" : "odd";
    doubled = inner(4);

    // Mutual recursion: each name resolves through the other.
    function isEven(n:int):Boolean { return n == 0 ? true : isOdd(n - 1); }
    function isOdd(n:int):Boolean { return n == 0 ? false : isEven(n - 1); }

    // A one-way sibling call plus a captured parameter.
    function doPad(n:int, w:int):String {
      var s:String = n.toString();
      while (s.length < w) s = "0" + s;
      return s;
    }
    function bumpBy(d:int):int { return start + d; }

    // A third level: `inner` sits inside a nested function and calls siblings of
    // ITS body, so the cell pointer has to be threaded one level down.
    function inner(k:int):String {
      function step1(x:int):String { return "v" + step2(x); }
      function step2(x:int):String { return (x * 2).toString(); }
      return step1(k);
    }
  }

  // The same shape inside a plain method body.
  public function outer(n:int):String {
    function inner1(k:int):String { return "o" + inner2(k); }
    function inner2(k:int):String { return (k + 1).toString(); }
    return inner1(n);
  }
}

var c:Counter = new Counter(7);
trace(c.label);
trace(c.parity);
trace(c.doubled);
trace(c.outer(4));
