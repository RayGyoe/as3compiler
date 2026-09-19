// stage76.as — C identifier naming-conflict handling (stage 76): a full C
// reserved-word table (C keywords + libc/libm/POSIX symbols) plus sanitize across
// class/method/field/local names, so AS3 identifiers like `index`/`time`/`log`/
// `union` can no longer collide with the linked Skia/SDL2/libc symbols.
//
// The AS3-side spelling is unchanged (source, reflection keys, for-in iteration
// all keep the original names); only the emitted C identifier is mangled.

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- 1. methods/fields named after C keywords & libc/libm/POSIX symbols ---
class Collision {
  var index:int = 7;
  var time:Number = 1.5;
  var data:String = "payload";

  function union(a:int, b:int):int { return a + b; }
  function log(x:Number):Number { return x * 10; }
  function read():int { return index; }
}

var c:Collision = new Collision();
check(c.index == 7, "field `index` (libc legacy alias)");
check(c.time == 1.5, "field `time` (time.h)");
check(c.data == "payload", "field `data`");
check(c.union(3, 4) == 7, "method `union` (C keyword)");
check(c.log(5) == 50, "method `log` (libm)");
check(c.read() == 7, "method `read` (unistd)");

// --- 2. a local variable named `index` ---
function testLocal():int {
  var index:int = 42;
  var time:int = index + 1;
  return time;
}
check(testLocal() == 43, "local vars `index`/`time`");

// --- 3. a package-less class literally named `index` (collides with libc) ---
class index {
  var value:int = 99;
  function readValue():int { return value; }
}
var ix:index = new index();
check(ix.readValue() == 99, "class named `index`");

// --- 4. AS3-side spelling unchanged: for-in keys keep the original names ---
var obj:Object = { index: 1, time: 2, union: 3 };
var hits:int = 0;
for (var k:String in obj) {
  if (k == "index" || k == "time" || k == "union") hits++;
}
check(hits == 3, "for-in keys preserve `index`/`time`/`union`");

trace("stage76: all C-identifier collision assertions passed");
