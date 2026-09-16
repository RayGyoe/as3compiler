// stage10.as — Vector.<T> 类型安全数组 + 越界检查

function testVector(): void {
  var v:Vector.<int> = new Vector.<int>();
  v.push(10);
  v.push(20);
  v.push(30);

  trace("length: " + v.length);
  trace("v[0]: " + v[0]);
  trace("v[1]: " + v[1]);
  trace("v[2]: " + v[2]);

  v[1] = 200;
  trace("v[1] after set: " + v[1]);

  trace("pop: " + v.pop());
  trace("length after pop: " + v.length);

  // 越界读取：触发 RangeError，被 catch (e:RangeError) 精确捕获
  try {
    var x:int = v[5];
    trace("should not reach");
  } catch (e:RangeError) {
    trace("caught RangeError: " + e.message);
  }
}

testVector();
