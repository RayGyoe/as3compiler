// A missing Array element / Array named property and a missing dynamic object
// property read as AIR's `undefined`, NOT null. Measured on adl 51.4.1
// (temp/qfix/gcadl/arrMain.as + omMain.as): the read renders as "undefined", the
// strict `=== undefined` check is true, and `== null` is still true (undefined
// and null are loosely equal). pop()/shift() on an empty array are undefined too.
function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

function run():void {
  // An array shortened by `length` leaves the removed slots as undefined.
  var e:* = [1,2,3,4];
  e.length = 2;
  check(e[3] === undefined, "array read past length is undefined");
  check(e[3] == null, "undefined is loosely equal to null");
  check("x" + e[3] == "xundefined", "concat renders undefined");

  // A canonical index past the end (including the string spelling) is undefined.
  var m:* = [1,2,3];
  check(m["7"] === undefined, "string index past length is undefined");
  var d:Array = [1,2,3];
  d.length = 1;
  check(d[5] === undefined, "statically-typed Array read past length is undefined");

  // Deletion and the empty-array mutators agree.
  var del:Array = [1,2,3];
  delete del[1];
  check(del[1] === undefined, "a deleted element reads as undefined");
  check([].pop() === undefined, "pop on an empty array is undefined");
  check([].shift() === undefined, "shift on an empty array is undefined");

  // Missing dynamic properties on objects and on Arrays read as undefined.
  var o:Object = {};
  check(o.bar === undefined, "missing object property is undefined");
  check(!("bar" in o), "`in` still reports absence");
  var full:* = {};
  full.k = 1;
  check(full.y === undefined, "a missing property next to a present one is undefined");
  var named:Array = [1];
  check(named.nope === undefined, "a missing named Array property is undefined");

  check([1,2].indexOf(9) == -1, "indexOf of a missing value is -1");

  trace("undefined-missing: all checks passed");
}

run();
