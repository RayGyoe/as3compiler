// stage9.as — Error 子类 (TypeError/RangeError/ArgumentError) + Date 类

function testCatch(): void {
  // 精确匹配：TypeError 被 catch (e:TypeError) 捕获
  try {
    throw new TypeError("type mismatch");
  } catch (e:TypeError) {
    trace("caught TypeError: " + e.message);
  }

  // 不匹配冒泡：RangeError 不被 catch (e:TypeError) 捕获，向上冒泡到 Error
  try {
    try {
      throw new RangeError("out of range");
    } catch (e:TypeError) {
      trace("should not reach");
    }
  } catch (e:Error) {
    trace("caught via Error: " + e.message);
  }

  // 基类兜底捕获 ArgumentError
  try {
    throw new ArgumentError("bad argument");
  } catch (e:Error) {
    trace("caught ArgumentError: " + e.message);
  }
}

function testDate(): void {
  var d:Date = new Date();
  trace("year >= 2020: " + (d.getFullYear() >= 2020));
  trace("month in 0..11: " + (d.getMonth() >= 0 && d.getMonth() <= 11));
  trace("day in 0..6: " + (d.getDay() >= 0 && d.getDay() <= 6));
  trace("time > 0: " + (d.getTime() > 0));
}

testCatch();
testDate();
